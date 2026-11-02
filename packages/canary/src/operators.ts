import { Project, SyntaxKind } from "ts-morph";

export type CanaryOperator = "flip_cmp" | "off_by_one" | "swap_args" | "drop_guard" | "const_step" | "negate_cond";

export interface CanaryCandidate {
  file: string;
  line: number;
  operator: CanaryOperator;
  patched: string;
  description: string;
}

const FLIP: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  ">=": "<",
  "<=": ">",
  ">": "<=",
  "<": ">=",
};

/** Propose one mutation with the given operator, or null when inapplicable. Pure. */
export function proposeWith(source: string, file: string, operator: CanaryOperator): CanaryCandidate | null {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("target.ts", source);
  try {
    switch (operator) {
      case "flip_cmp": {
        const found = sf.getDescendantsOfKind(SyntaxKind.BinaryExpression).find((b) => FLIP[b.getOperatorToken().getText()] !== undefined);
        if (!found) return null;
        const op = found.getOperatorToken();
        const next = FLIP[op.getText()] as string;
        op.replaceWithText(next);
        return {
          file,
          line: found.getStartLineNumber(),
          operator,
          patched: sf.getFullText(),
          description: `flipped comparison to ${next}`,
        };
      }
      case "negate_cond": {
        const found = sf.getDescendantsOfKind(SyntaxKind.IfStatement)[0];
        if (!found) return null;
        const cond = found.getExpression();
        cond.replaceWithText(`!(${cond.getText()})`);
        return { file, line: found.getStartLineNumber(), operator, patched: sf.getFullText(), description: "negated if condition" };
      }
      case "off_by_one": {
        const found = sf.getDescendantsOfKind(SyntaxKind.NumericLiteral).find((n) => {
          const p = n.getParent();
          return p !== undefined && (p.getKind() === SyntaxKind.BinaryExpression || p.getKind() === SyntaxKind.PrefixUnaryExpression);
        });
        if (!found) return null;
        const value = Number(found.getText());
        if (!Number.isInteger(value)) return null;
        found.replaceWithText(String(value + 1));
        return { file, line: found.getStartLineNumber(), operator, patched: sf.getFullText(), description: `literal ${value} to ${value + 1}` };
      }
      case "const_step": {
        const found = sf.getDescendantsOfKind(SyntaxKind.NumericLiteral)[0];
        if (!found) return null;
        const value = Number(found.getText());
        found.replaceWithText(String(value * 10));
        return { file, line: found.getStartLineNumber(), operator, patched: sf.getFullText(), description: `const ${value} to ${value * 10}` };
      }
      case "drop_guard": {
        const found = sf
          .getDescendantsOfKind(SyntaxKind.IfStatement)
          .find((s) => !s.getElseStatement() && /return|throw/.test(s.getThenStatement().getText()));
        if (!found) return null;
        const line = found.getStartLineNumber();
        found.remove();
        return { file, line, operator, patched: sf.getFullText(), description: "dropped guard clause" };
      }
      case "swap_args": {
        const found = sf.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getArguments().length >= 2);
        if (!found) return null;
        const args = found.getArguments().map((a) => a.getText());
        const first = args[0] as string;
        args[0] = args[1] as string;
        args[1] = first;
        found.replaceWithText(`${found.getExpression().getText()}(${args.join(", ")})`);
        return { file, line: found.getStartLineNumber(), operator, patched: sf.getFullText(), description: "swapped first two arguments" };
      }
    }
  } catch {
    return null;
  }
}

/** First applicable operator in a fixed priority order. Pure. */
export function proposeCanary(source: string, file: string): CanaryCandidate | null {
  const order: CanaryOperator[] = ["flip_cmp", "negate_cond", "drop_guard", "off_by_one", "swap_args", "const_step"];
  for (const op of order) {
    const c = proposeWith(source, file, op);
    if (c) return c;
  }
  return null;
}
