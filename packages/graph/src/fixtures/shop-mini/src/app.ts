import { app, Router } from "./stub.js";
import { list } from "./service.js";

const router = Router();
router.get("/items", () => list());
app.use("/api", router);
app.get("/health", () => "ok");
