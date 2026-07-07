import { contextBridge } from "electron";

const apiBaseUrl = process.argv
  .find((arg) => arg.startsWith("--zyquor-api="))
  ?.slice("--zyquor-api=".length) ?? "http://127.0.0.1:3000";

contextBridge.exposeInMainWorld("zyquor", { apiBaseUrl });
