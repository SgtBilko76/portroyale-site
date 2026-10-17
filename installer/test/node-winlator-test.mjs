// Node test of the WinlatorXR installer's ADB calls (same Tango APIs as winlator.js):
// version check, free space, unzip + sync push of a mod package into a TEST folder.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { WebUSB } from "usb";
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { unzipSync } from "fflate";
import { parseWxrVersion } from "../src/winlator.js";

const pem = readFileSync(homedir() + "/.android/adbkey", "utf8");
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
const credentialStore = { async generateKey() { throw new Error("x"); }, async *iterateKeys() { yield { buffer: new Uint8Array(der), name: "test" }; } };

for (const s of ["dawn-33", "WinlatorXR-dawn-42.apk", "eat-03", "cats-27"]) console.log("parse", s, JSON.stringify(parseWxrVersion(s)));

const manager = new AdbDaemonWebUsbDeviceManager(new WebUSB({ allowedDevices: [{ vendorId: 0x2833 }] }));
const [device] = await manager.getDevices();
{ const raw = device.raw, orig = raw.transferIn; raw.transferIn = (ep, len) => orig.call(raw, ep, len, 3600000); }
const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection: await device.connect(), credentialStore });
const adb = new Adb(transport);
const sh = (c) => adb.subprocess.noneProtocol.spawnWaitText(c);

const ver = await sh("dumpsys package com.winlator.cmod | grep -m1 versionName");
console.log("installed:", ver.trim());
console.log("df:", (await sh("df -k /sdcard/Download")).trim().split("\n").pop());
console.log("exists CallOfDuty4/iw3sp.exe:", (await sh("[ -e '/sdcard/Download/CallOfDuty4/iw3sp.exe' ] && echo yes")).trim() || "no");

const zip = readFileSync(process.argv[2]);
const entries = Object.entries(unzipSync(new Uint8Array(zip))).filter(([p]) => !p.endsWith("/"));
const sync = await adb.sync();
const t0 = Date.now();
for (const [p, data] of entries) {
  await sync.write({ filename: `/sdcard/Download/PRTest/${p}`, file: new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }) });
}
await sync.dispose();
console.log(`pushed ${entries.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log((await sh("cd /sdcard/Download/PRTest && find . -type f | wc -l && du -sk .")).trim());
await adb.close();
process.exit(0);
