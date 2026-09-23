const projectRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const userHome = Deno.env.get("HOME");
if (!userHome || !userHome.startsWith("/Users/")) {
  throw new Error("無法辨識 macOS 使用者目錄");
}

const label = "com.expense-ledger.invoice-automation";
const launchAgentsDirectory = `${userHome}/Library/LaunchAgents`;
const plistPath = `${launchAgentsDirectory}/${label}.plist`;
const privateDirectory = `${projectRoot}/test-fixtures/private/automation`;
const installSkipPath = `${privateDirectory}/skip-install-run`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${Deno.execPath()}</string>
    <string>run</string>
    <string>-A</string>
    <string>${projectRoot}/scripts/invoice-automation.js</string>
    <string>--scheduled</string>
  </array>
  <key>WorkingDirectory</key><string>${projectRoot}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${privateDirectory}/schedule.log</string>
  <key>StandardErrorPath</key><string>${privateDirectory}/schedule-error.log</string>
</dict>
</plist>
`;

await Deno.mkdir(launchAgentsDirectory, { recursive: true });
await Deno.mkdir(privateDirectory, { recursive: true });
await Deno.writeTextFile(plistPath, xml);
await Deno.writeTextFile(installSkipPath, "skip this install-time RunAtLoad\n");
const domainTarget = `gui/${Deno.uid()}`;
await new Deno.Command("/bin/launchctl", {
  args: ["bootout", domainTarget, plistPath],
  stdout: "null",
  stderr: "null",
}).output();
const result = await new Deno.Command("/bin/launchctl", {
  args: ["bootstrap", domainTarget, plistPath],
}).output();
if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
console.log(`已安裝每天 09:00 並於登入時補跑的排程：${plistPath}`);
