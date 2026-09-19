import net from "net";
import { isProxyRequired } from "open-sse/utils/egressPolicy.js";

const INTERNET_CHECK = {
  host: "1.1.1.1",
  port: 443,
  timeoutMs: 3000,
};

// Said once per process, not once per tick: the watchdog runs on an interval.
let announced = false;

export function checkInternet() {
  // A raw socket, so the fail-closed policy never sees it — it goes straight to
  // the kernel and the firewall REJECTs it, every tick, forever. Nothing is
  // gained by asking: on a proxy-required host this probe cannot succeed, and
  // its only consumers are the tunnel and tailscale self-heal paths, which are
  // supervised by systemd here rather than by the app. Left alone it fills the
  // kernel log with KROUTER-EGRESS-BLOCKED, which is exactly the signal a real
  // leak would have to stand out against.
  if (isProxyRequired()) {
    if (!announced) {
      announced = true;
      console.log(
        "[Tunnel] internet probe skipped: NINEROUTER_REQUIRE_PROXY refuses direct egress. " +
        "Tunnel and tailscale self-heal stay idle; supervise them outside the app."
      );
    }
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(INTERNET_CHECK.timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try { socket.connect(INTERNET_CHECK.port, INTERNET_CHECK.host); }
    catch { finish(false); }
  });
}
