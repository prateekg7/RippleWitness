import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
import { z } from "zod";
import type { EdgeConfidence, GraphEdge, GraphNode, StaticGraph } from "./types.js";
import type { SubjectLanguage } from "./language.js";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MAX_CALL_DEPTH = 3;
const SQL_TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+["'`[]?([A-Za-z_][\w]*)/gi;

const RootDirSchema = z.string().min(1);

interface FnInfo {
  id: string;
  node: Node;
  file: SourceFile;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function rangeOf(node: Node): [number, number] {
  return [node.getStartLineNumber(), node.getEndLineNumber()];
}

function stringArg(call: CallExpression, index: number): string | null {
  const arg = call.getArguments()[index];
  if (!arg) return null;
  if (arg.getKind() === SyntaxKind.StringLiteral) {
    return (arg.asKindOrThrow(SyntaxKind.StringLiteral)).getLiteralValue();
  }
  if (arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return arg.asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral).getLiteralValue();
  }
  return null;
}

/** Resolve `name` to a project-local function-ish declaration, if exactly one exists. */
function resolveFunction(projectFiles: SourceFile[], container: SourceFile, name: string): FnInfo | null {
  const found: FnInfo[] = [];
  const scopes = [container, ...projectFiles.filter((f) => f !== container)];
  for (const file of scopes) {
    for (const fn of file.getFunctions()) {
      if (fn.getName() === name) found.push({ id: "", node: fn, file });
    }
    for (const v of file.getVariableDeclarations()) {
      if (v.getName() === name) {
        const init = v.getInitializer();
        if (init && (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression)) {
          found.push({ id: "", node: v, file });
        }
      }
    }
    for (const cls of file.getClasses()) {
      for (const m of cls.getMethods()) {
        if (m.getName() === name) found.push({ id: "", node: m, file });
      }
    }
    if (found.length > 0) break;
  }
  if (found.length !== 1) return null;
  return found[0] as FnInfo;
}

export interface ExtractOptions {
  /** Explicit language; wins over detection (TRD §7.2). Python is handled by the J-03 extractor. */
  language?: SubjectLanguage;
}

/** Shared file filter: in-root, no deps/build output, no test files. */
function keepFile(rootDir: string, filePath: string): boolean {
  return (
    filePath.startsWith(rootDir) &&
    !filePath.includes("node_modules") &&
    !filePath.includes("/dist/") &&
    !filePath.endsWith(".test.ts") &&
    !filePath.endsWith(".test.js")
  );
}

export function extractStaticGraph(rootDirInput: string, opts: ExtractOptions = {}): StaticGraph {
  const rootDir = RootDirSchema.parse(rootDirInput);
  if (opts.language === "python") throw new Error("python extraction is handled by the Python extractor (J-03), not ts-morph");
  let project: Project;
  if (existsSync(join(rootDir, "tsconfig.json"))) {
    project = new Project({ tsConfigFilePath: `${rootDir}/tsconfig.json` });
  } else {
    // Plain-JS subject (F-18): no tsconfig — load sources directly with allowJs.
    project = new Project({ compilerOptions: { allowJs: true, checkJs: false } });
    project.addSourceFilesAtPaths([`${rootDir}/**/*.js`, `${rootDir}/**/*.jsx`]);
  }
  const allFiles = project.getSourceFiles().filter((f) => keepFile(rootDir, f.getFilePath()));
  const relOf = (f: SourceFile): string => toPosix(relative(rootDir, f.getFilePath()));

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const addNode = (n: GraphNode): void => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const addEdge = (from: string, to: string, type: GraphEdge["type"], confidence: EdgeConfidence): void => {
    const key = `${from}\0${to}\0${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, type, confidence });
  };

  // Pass 0: find routers (express.Router()) and their mount prefixes.
  const routerVars = new Map<SourceFile, Set<string>>();
  const routerPrefix = new Map<string, string>(); // varName -> prefix (per file key below)
  for (const file of allFiles) {
    const vars = new Set<string>();
    for (const v of file.getVariableDeclarations()) {
      const init = v.getInitializer();
      if (init?.getText().includes("Router()")) vars.add(v.getName());
    }
    routerVars.set(file, vars);
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const pa = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (pa.getName() !== "use") continue;
      const prefix = stringArg(call, 0);
      const routerArg = call.getArguments()[1]?.getText() ?? "";
      if (prefix !== null && vars.has(routerArg)) routerPrefix.set(`${relOf(file)}:${routerArg}`, prefix);
    }
  }

  // Config definitions: file exporting `config` object -> property ranges.
  const configDef = new Map<string, { file: string; range: [number, number] }>();
  for (const file of allFiles) {
    for (const v of file.getVariableDeclarations()) {
      if (v.getName() !== "config") continue;
      let init: Node | undefined = v.getInitializer();
      // Unwrap `as const` / satisfies / parens to reach the object literal.
      for (;;) {
        if (!init) break;
        if (Node.isAsExpression(init) || Node.isSatisfiesExpression(init) || Node.isParenthesizedExpression(init)) {
          init = init.getExpression();
        } else break;
      }
      if (init?.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
      for (const prop of init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties()) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const name = prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName();
          configDef.set(name, { file: relOf(file), range: rangeOf(prop) });
        }
      }
    }
  }
  const configNode = (name: string): string => {
    const id = `config:${name}`;
    const def = configDef.get(name);
    const node: GraphNode = def
      ? { id, kind: "config", label: name, file: def.file, range: def.range }
      : { id, kind: "config", label: name };
    addNode(node);
    return id;
  };
  const tableNode = (table: string): string => {
    const id = `db:${table}`;
    addNode({ id, kind: "db_table", label: table });
    return id;
  };

  const fnId = (file: SourceFile, name: string): string => `fn:${relOf(file)}:${name}`;

  const FN_KINDS = new Set([
    SyntaxKind.ArrowFunction,
    SyntaxKind.FunctionExpression,
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.MethodDeclaration,
  ]);

  /** True iff `desc` sits directly in `body` (not inside a nested closure). */
  function isDirect(desc: Node, boundary: Node): boolean {
    let p: Node | undefined = desc.getParent();
    while (p) {
      if (p === boundary) return true;
      if (FN_KINDS.has(p.getKind())) return false;
      p = p.getParent();
    }
    return false;
  }

  function boundaryOf(body: Node): Node {
    if (body.getKind() === SyntaxKind.VariableDeclaration) {
      const init = body.asKindOrThrow(SyntaxKind.VariableDeclaration).getInitializer();
      if (init) return init;
    }
    return body;
  }

  // Per-function body scan: calls, db access, config reads. Attribution is
  // innermost-function only: nested closures (inline handlers, callbacks)
  // are skipped here and scanned under their own ids. `mode: "facts"` skips
  // call edges (used by the orphan pass so the call graph stays
  // handler-rooted per TRD §7.1).
  const scanned = new Set<string>();
  function scanFunctionBody(
    fnIdStr: string,
    body: Node,
    file: SourceFile,
    depth: number,
    mode: "all" | "facts" = "all",
  ): void {
    if (depth > MAX_CALL_DEPTH) return;
    const scanKey = `${fnIdStr}@${depth}@${mode}`;
    if (scanned.has(scanKey)) return;
    scanned.add(scanKey);
    const boundary = boundaryOf(body);
    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      if (!isDirect(call, boundary)) continue;
      const expr = call.getExpression();
      // db.prepare("...") / db.exec("..."): table detection (string literals only).
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const pa = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const method = pa.getName();
        if (mode === "facts" && method !== "prepare" && method !== "exec") continue;
        if (method === "prepare" || method === "exec") {
          const sql = stringArg(call, 0);
          if (sql !== null) {
            const isRead = /^\s*select\b/i.test(sql);
            for (const m of sql.matchAll(SQL_TABLE_RE)) {
              const table = m[1] as string;
              if (["select", "where"].includes(table.toLowerCase())) continue;
              addEdge(fnIdStr, tableNode(table), isRead ? "reads" : "writes", "EXTRACTED");
            }
          }
          continue;
        }
        // bus.emit("...") / bus.on("..."): DOCUMENTED BLIND SPOT — never resolve
        // string-keyed dispatch (events, feature flags). Skip silently.
        const objText = pa.getExpression().getText();
        if (objText === "bus" && (method === "emit" || method === "on")) continue;
        // obj.method(...) calls: resolve `method` by name.
        if (ROUTE_METHODS.has(method)) continue; // route registrations, not calls
        const resolved = resolveFunction(allFiles, file, method);
        if (resolved) {
          const calleeId = fnId(resolved.file, method);
          addNode({
            id: calleeId,
            kind: "service",
            label: method,
            file: relOf(resolved.file),
            range: rangeOf(resolved.node),
          });
          addEdge(fnIdStr, calleeId, "calls", "EXTRACTED");
          if (depth < MAX_CALL_DEPTH) scanFunctionBody(calleeId, resolved.node, resolved.file, depth + 1);
        } else if (/^[A-Za-z_$][\w$]*$/.test(method) && !["run", "get", "all", "exec", "json", "status", "set", "listen", "use", "on", "emit"].includes(method)) {
          addEdge(fnIdStr, `fn:unresolved:${method}`, "calls", "INFERRED");
          addNode({ id: `fn:unresolved:${method}`, kind: "service", label: `${method} (unresolved)` });
        }
        continue;
      }
      // free function call: name(...)
      if (expr.getKind() === SyntaxKind.Identifier) {
        if (mode === "facts") continue;
        const name = expr.getText();
        if (["require", "String", "Number", "JSON", "console"].includes(name)) continue;
        const resolved = resolveFunction(allFiles, file, name);
        if (resolved) {
          const calleeId = fnId(resolved.file, name);
          addNode({
            id: calleeId,
            kind: "service",
            label: name,
            file: relOf(resolved.file),
            range: rangeOf(resolved.node),
          });
          addEdge(fnIdStr, calleeId, "calls", "EXTRACTED");
          if (depth < MAX_CALL_DEPTH) scanFunctionBody(calleeId, resolved.node, resolved.file, depth + 1);
        }
      }
    }
    // process.env.X reads.
    for (const pa of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (!isDirect(pa, boundary)) continue;
      const full = pa.getText();
      const m = /^process\.env\.([A-Za-z_][\w]*)$/.exec(full);
      if (m) addEdge(fnIdStr, configNode(`env:${m[1]}`), "config", "EXTRACTED");
      const cm = /^config\.([A-Za-z_][\w]*)$/.exec(full);
      if (cm && configDef.has(cm[1] as string)) addEdge(fnIdStr, configNode(cm[1] as string), "config", "EXTRACTED");
    }
  }

  // Pass 1: route discovery.
  for (const file of allFiles) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const pa = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const method = pa.getName().toUpperCase();
      if (!ROUTE_METHODS.has(pa.getName())) continue;
      const rawPath = stringArg(call, 0);
      if (rawPath === null) continue;
      const objName = pa.getExpression().getText();
      const prefix = routerPrefix.get(`${relOf(file)}:${objName}`) ?? "";
      const routeId = `route:${method} ${prefix}${rawPath}`;
      addNode({ id: routeId, kind: "route", label: `${method} ${prefix}${rawPath}`, file: relOf(file), range: rangeOf(call) });
      const args = call.getArguments().slice(1);
      args.forEach((handler, i) => {
        const text = handler.getText();
        let name = text;
        if (handler.getKind() === SyntaxKind.ArrowFunction || handler.getKind() === SyntaxKind.FunctionExpression) {
          name = `${routeId}#h${i}`;
        } else if (handler.getKind() === SyntaxKind.Identifier) {
          name = text;
        } else {
          return;
        }
        const hid = `handler:${relOf(file)}:${name}`;
        addNode({ id: hid, kind: "handler", label: name, file: relOf(file), range: rangeOf(handler) });
        addEdge(routeId, hid, "calls", "EXTRACTED");
        // Named handler references resolve to their declarations; inline bodies scan directly.
        if (handler.getKind() === SyntaxKind.Identifier) {
          const resolved = resolveFunction(allFiles, file, name);
          if (resolved) scanFunctionBody(hid, resolved.node, resolved.file, 1);
        } else {
          scanFunctionBody(hid, handler, file, 1);
        }
      });
    }
  }

  // Pass 2: scan every declared function (including entry points like
  // openDb/seed that no handler calls) so db/config edges are complete.
  for (const file of allFiles) {
    const decls: { name: string; node: Node }[] = [];
    for (const fn of file.getFunctions()) {
      if (fn.getName()) decls.push({ name: fn.getName() as string, node: fn });
    }
    for (const v of file.getVariableDeclarations()) {
      const init = v.getInitializer();
      if (init && (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression)) {
        decls.push({ name: v.getName(), node: v });
      }
    }
    for (const d of decls) {
      const id = fnId(file, d.name);
      addNode({ id, kind: "service", label: d.name, file: relOf(file), range: rangeOf(d.node) });
      scanFunctionBody(id, d.node, file, 1, "facts");
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sortedEdges = edges.sort((a, b) =>
    a.from === b.from ? (a.to === b.to ? (a.type < b.type ? -1 : 1) : a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
  );
  return { nodes: sortedNodes, edges: sortedEdges };
}
