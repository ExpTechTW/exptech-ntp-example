import dgram from "dgram";

const NTP_EPOCH = 2208988800; // 1900 到 1970 的秒數

const NTP_PORT = 123;

// 自架伺服器
const API_URL = "https://lb.exptech.dev/ntp";
const NTP_SERVER = "time.exptech.com.tw";

interface NtpResult {
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  offset: number;
  rtt: number;
}

// 讀取 32-bit 大端序無符號整數
function readUInt32BE(buf: Buffer, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

// 寫入 32-bit 大端序整數
function writeUInt32BE(buf: Buffer, value: number, offset: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

// 從 NTP 時間戳格式轉換為毫秒
function fromNtpTimestamp(sec: number, frac: number): number {
  const unixSec = sec - NTP_EPOCH;
  const fracMs = (frac >>> 0) / 0x100000000 * 1000;
  return unixSec * 1000 + fracMs;
}

// 將毫秒時間戳轉換為 NTP 格式字節
function toNtpBytes(timeMs: number): Buffer {
  const unixSec = timeMs / 1000;
  const ntpSec = Math.floor(unixSec) + NTP_EPOCH;
  const frac = Math.floor((unixSec % 1) * 0x100000000);

  const buf = Buffer.alloc(8);
  writeUInt32BE(buf, ntpSec, 0);
  writeUInt32BE(buf, frac, 4);
  return buf;
}

// 解析 NTP 回應封包
function parseNtpPacket(data: Buffer): { t2: number; t3: number } | null {
  if (data.length < 48) return null;

  // Receive Timestamp (T2): 字節 32-39
  const t2Sec = readUInt32BE(data, 32);
  const t2Frac = readUInt32BE(data, 36);
  const t2 = fromNtpTimestamp(t2Sec, t2Frac);

  // Transmit Timestamp (T3): 字節 40-47
  const t3Sec = readUInt32BE(data, 40);
  const t3Frac = readUInt32BE(data, 44);
  const t3 = fromNtpTimestamp(t3Sec, t3Frac);

  return { t2, t3 };
}

// 使用標準 NTP 協議同步時間
async function ntpSync(server: string = NTP_SERVER): Promise<NtpResult> {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error("NTP request timeout"));
    }, 5000);

    // 構建 NTP 請求封包
    const packet = Buffer.alloc(48);
    packet[0] = 0x23; // LI=0, VN=4, Mode=3 (client)

    // T1: 客戶端發送時間
    const t1 = Date.now();
    const t1Bytes = toNtpBytes(t1);
    t1Bytes.copy(packet, 40); // Transmit Timestamp

    client.on("message", (msg) => {
      // T4: 客戶端收到回應時間
      const t4 = Date.now();
      clearTimeout(timeout);
      client.close();

      const result = parseNtpPacket(msg);
      if (!result) {
        reject(new Error("Invalid NTP response"));
        return;
      }

      const { t2, t3 } = result;

      // 標準 NTP 公式
      const offset = ((t2 - t1) + (t3 - t4)) / 2;
      const rtt = (t4 - t1) - (t3 - t2);

      resolve({ t1, t2, t3, t4, offset, rtt });
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });

    client.send(packet, NTP_PORT, server);
  });
}

// 使用自架 API 同步時間
async function apiSync(): Promise<NtpResult> {
  const t1 = Date.now();

  const response = await fetch(API_URL, { method: "HEAD" });

  const t4 = Date.now();

  const t2Str = response.headers.get("X-NTP-T2");
  const t3Str = response.headers.get("X-NTP-T3");
  const status = response.headers.get("X-NTP-Status");

  if (!t2Str || !t3Str) {
    throw new Error(`Missing NTP headers. Status: ${status}`);
  }

  const t2 = parseFloat(t2Str);
  const t3 = parseFloat(t3Str);

  // 標準 NTP 公式
  const offset = ((t2 - t1) + (t3 - t4)) / 2;
  const rtt = (t4 - t1) - (t3 - t2);

  return { t1, t2, t3, t4, offset, rtt };
}

// 多次取樣並計算平均值
async function multiSample<T extends NtpResult>(
  fn: () => Promise<T>,
  samples: number = 5,
  delayMs: number = 1000
): Promise<{ results: T[]; avgOffset: number; avgRtt: number }> {
  const results: T[] = [];

  for (let i = 0; i < samples; i++) {
    try {
      const result = await fn();
      results.push(result);
      if (i < samples - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err) {
      console.error(`Sample ${i + 1} failed:`, err);
    }
  }

  const avgOffset = results.reduce((sum, r) => sum + r.offset, 0) / results.length;
  const avgRtt = results.reduce((sum, r) => sum + r.rtt, 0) / results.length;

  return { results, avgOffset, avgRtt };
}

// 格式化結果輸出
function formatResult(label: string, result: NtpResult): void {
  console.log(`  T1 (發送): ${result.t1}`);
  console.log(`  T2 (收到): ${result.t2}`);
  console.log(`  T3 (回應): ${result.t3}`);
  console.log(`  T4 (收到): ${result.t4}`);
  console.log(`  Offset:    ${result.offset.toFixed(3)} ms`);
  console.log(`  RTT:       ${result.rtt.toFixed(3)} ms`);
}

async function main() {
  console.log("=".repeat(60));
  console.log("NTP 時間同步測試 (UDP vs HTTP)");
  console.log("=".repeat(60));

  try {
    // 測試自架 UDP SNTP
    console.log("\n[1] 自架 UDP SNTP (lb.exptech.dev:123)");
    console.log("-".repeat(40));

    const udp = await multiSample(() => ntpSync(NTP_SERVER), 5, 500);
    console.log(`取樣次數: ${udp.results.length}`);
    console.log(`平均 Offset: ${udp.avgOffset.toFixed(3)} ms`);
    console.log(`平均 RTT:    ${udp.avgRtt.toFixed(3)} ms`);

    if (udp.results.length > 0) {
      console.log("\n最後一次取樣:");
      formatResult("UDP", udp.results[udp.results.length - 1]);
    }

    // 測試自架 HTTP API
    console.log("\n[2] 自架 HTTP API (lb.exptech.dev/ntp)");
    console.log("-".repeat(40));

    const http = await multiSample(apiSync, 5, 500);
    console.log(`取樣次數: ${http.results.length}`);
    console.log(`平均 Offset: ${http.avgOffset.toFixed(3)} ms`);
    console.log(`平均 RTT:    ${http.avgRtt.toFixed(3)} ms`);

    console.log("\n最後一次取樣:");
    formatResult("HTTP", http.results[http.results.length - 1]);

    // 比較結果
    console.log("\n[3] UDP vs HTTP 比較");
    console.log("=".repeat(60));

    const offsetDiff = http.avgOffset - udp.avgOffset;
    const rttDiff = http.avgRtt - udp.avgRtt;

    console.log(`UDP  Offset: ${udp.avgOffset.toFixed(3)} ms`);
    console.log(`HTTP Offset: ${http.avgOffset.toFixed(3)} ms`);
    console.log(`差異:        ${offsetDiff.toFixed(3)} ms`);
    console.log();
    console.log(`UDP  RTT:    ${udp.avgRtt.toFixed(3)} ms`);
    console.log(`HTTP RTT:    ${http.avgRtt.toFixed(3)} ms`);
    console.log(`差異:        ${rttDiff.toFixed(3)} ms`);

  } catch (err) {
    console.error("測試失敗:", err);
    process.exit(1);
  }
}

main();
