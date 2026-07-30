import assert from "node:assert/strict";
import { test } from "node:test";

import { createDigitalKeyServer } from "../../src/server/index.js";

test("生产服务可从带尾部分隔符的 dist URL 返回首页", async () => {
  const server = createDigitalKeyServer({
    root: new URL("../../dist/", import.meta.url),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root"><\/div>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
