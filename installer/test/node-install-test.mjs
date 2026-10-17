// Node end-to-end test of the installer path: relay download -> WebUSB ADB -> pm installStream.
process.on("unhandledRejection", (e) => console.log("UNHANDLED:", e && e.stack || e));
// Uses the node "usb" package's WebUSB and the host's existing ~/.android/adbkey.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { WebUSB } from "usb";
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { pmInstallStream } from "../src/pm-install.js";

const pem = readFileSync(homedir() + "/.android/adbkey", "utf8");
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
const credentialStore = {
  async generateKey() { throw new Error("no key gen in test"); },
  async *iterateKeys() { yield { buffer: new Uint8Array(der), name: "test@host" }; },
};

const manager = new AdbDaemonWebUsbDeviceManager(new WebUSB({ allowedDevices: [{ vendorId: 0x2833 }] }));
const [device] = await manager.getDevices();
if (!device) throw new Error("no device");
// node "usb" times out IN transfers after 1 s (browsers never do); ADB reads idle for longer.
{ const raw = device.raw, orig = raw.transferIn; raw.transferIn = (ep, len) => orig.call(raw, ep, len, 3600000); }
const connection = await device.connect();
const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore });
const adb = new Adb(transport);
console.log("connected", await adb.getProp("ro.product.manufacturer"), await adb.getProp("ro.product.model"));

const url = process.argv[2];
const relay = process.argv[3] || "http://127.0.0.1:8787";
const res = await fetch(`${relay}/?url=${encodeURIComponent(url)}`, { headers: { Origin: "http://localhost:8000" } });
if (!res.ok) throw new Error("relay " + res.status);
const size = Number(res.headers.get("Content-Length"));
let sent = 0, last = 0;
const counter = new TransformStream({ transform(c, ctl) { sent += c.byteLength; if (sent - last > size / 10 || sent === size) { last = sent; console.log(`  ${(sent / size * 100).toFixed(0)}%`); } ctl.enqueue(c); } });
const t0 = Date.now();
try {
  await pmInstallStream(adb, size, res.body.pipeThrough(counter));
  console.log(`installed ${size} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.log("INSTALL ERROR:", e.message);
}
await adb.close();
process.exit(0);
