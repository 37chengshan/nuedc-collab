import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "../styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("缺少数字钥匙工作台挂载节点");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
