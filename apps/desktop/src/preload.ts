import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type UpdateStatus = {
  state: "checking" | "available" | "downloaded" | "error";
  version: string | null;
};

const apiBaseUrl = process.argv
  .find((arg) => arg.startsWith("--zyquor-api="))
  ?.slice("--zyquor-api=".length) ?? "http://127.0.0.1:3000";

const appVersion = process.argv
  .find((arg) => arg.startsWith("--zyquor-version="))
  ?.slice("--zyquor-version=".length) ?? "";

contextBridge.exposeInMainWorld("zyquor", {
  apiBaseUrl,
  appVersion,
  updates: {
    getStatus: () => ipcRenderer.invoke("zyquor:update-status:get") as Promise<UpdateStatus | null>,
    onStatus: (listener: (status: UpdateStatus | null) => void) => {
      const handler = (_event: IpcRendererEvent, status: UpdateStatus | null) => listener(status);
      ipcRenderer.on("zyquor:update-status", handler);
      return () => ipcRenderer.removeListener("zyquor:update-status", handler);
    },
  },
});
