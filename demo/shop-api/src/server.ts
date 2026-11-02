import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8101);
const app = createApp();
app.listen(port, "127.0.0.1", () => console.log(`shop-api listening:${port}`));
