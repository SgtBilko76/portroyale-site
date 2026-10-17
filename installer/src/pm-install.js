// Streamed `pm install` that waits for pm's answer.
// @yume-chan/android-bin's PackageManager.installStream closes stdin when the
// upload ends, which on abb_exec closes the whole socket, so pm's "Success"
// is lost and the call fails even though the app got installed. Here stdin
// stays open until pm has answered and closed the socket itself.
import { AdbFeature, AdbNoneProtocolProcessImpl } from "@yume-chan/adb";
import { PackageManager } from "@yume-chan/android-bin";

export async function pmInstallStream(adb, size, stream) {
  let proc;
  if (adb.canUseFeature(AdbFeature.AbbExec)) {
    proc = new AdbNoneProtocolProcessImpl(await adb.createSocket(`abb_exec:package\0install\0-r\0-S\0${size}\0`));
  } else if (adb.canUseFeature(AdbFeature.Cmd)) {
    proc = await adb.subprocess.noneProtocol.spawn(`cmd package install -r -S ${size}`);
  } else {
    // very old Android: push to /data/local/tmp, then install
    return new PackageManager(adb).installStream(size, stream);
  }

  const readOutput = (async () => {
    const reader = proc.output.getReader();
    const dec = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    } catch { /* socket closed */ }
    return (text + dec.decode()).trim();
  })();

  let uploaded = 0;
  const counted = stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) { uploaded += chunk.byteLength; ctl.enqueue(chunk); },
  }));
  const upload = counted.pipeTo(proc.stdin, { preventClose: true }).then(() => null, (e) => {
    // A failure before all bytes are sent (e.g. the download broke) leaves pm
    // waiting forever: close the socket so it gives up. A failure after the
    // last byte is just pm closing the socket once it has answered.
    if (uploaded < size) Promise.resolve().then(() => proc.kill()).catch(() => {});
    return e;
  });

  const [output, uploadErr] = await Promise.all([readOutput, upload]);
  try { await proc.kill(); } catch { /* already closed */ }
  if (/^Success/m.test(output)) return;
  if (output) throw new Error(output);
  throw uploadErr instanceof Error ? uploadErr : new Error("The install was interrupted.");
}
