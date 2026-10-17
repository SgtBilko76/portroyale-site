// UI test: a fake headset so the connected state can be screenshotted without WebUSB.
export * from "../../src/common.js";
import { setConn } from "../../src/common.js";
export const usbSupported = () => true;
export async function connect() {
  const fake = { maker: "Oculus", model: "Quest 3", isPico: false, adb: { subprocess: { noneProtocol: { spawnWaitText: async (c) =>
    c.startsWith("dumpsys") ? "    versionName=dawn-33\n" : c.startsWith("df") ? "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/fuse 470203100 452407872 17647772 97% /storage/emulated\n" : "" } } } };
  setConn(fake);
  return fake;
}
