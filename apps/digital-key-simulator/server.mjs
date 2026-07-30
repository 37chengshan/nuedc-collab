import { parseArgs } from "node:util";

import { createDigitalKeyServer } from "./src/server/index.js";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: {
      type: "string",
      default: process.env.DIGITAL_KEY_PORT ?? "4180",
    },
  },
});

const port = Number.parseInt(values.port, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`无效端口: ${values.port}`);
}

const server = await createDigitalKeyServer({
  root: new URL("./dist/", import.meta.url),
});

server.listen(port, values.host, () => {
  console.log(`数字钥匙仿真工作台已启动: http://${values.host}:${port}`);
  console.log("现有 UWB Lab 保持独立运行于 http://127.0.0.1:4173");
});
