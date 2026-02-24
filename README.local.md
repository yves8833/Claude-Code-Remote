# Claude Code Remote — Local Setup

## Overview

透過 Email 遠端控制 Claude Code。Session 結束時自動發送包含對話摘要的 Email 通知，回覆 Email 即可下達新指令。

```
Claude Code Session
    ↓ (Stop/Notification/PermissionRequest hook)
claude-hook-notify.js
    ↓ 讀取 stdin transcript → 提取對話內容
    ├── Desktop 通知 (系統聲音)
    └── Email 通知 (SMTP → Gmail)

Email 回覆
    ↓ (IMAP IDLE 監聽)
relay-pty.js
    ↓ 提取 token + 指令
    ├── AppleScript 自動貼上 (macOS)
    └── Clipboard fallback
```

## 檔案結構

```
~/.claude/
├── settings.json              # Hooks 全域設定
└── Claude-Code-Remote/        # 本體
    ├── .env                   # Email 憑證 (SMTP/IMAP)
    ├── claude-hook-notify.js  # Hook 腳本 (已改寫：讀取 stdin transcript)
    └── src/
        ├── relay/relay-pty.js # IMAP relay 服務 (已改寫：只掃近 24h 信件)
        └── data/
            ├── relay.log      # Relay 服務 log
            ├── session-map.json
            └── sessions/      # Session 記錄
```

## Hooks 配置

| Event | 觸發時機 | 動作 |
|-------|---------|------|
| **Stop** | Session 結束 | `claude-hook-notify.js completed` → Email + Desktop |
| **Notification** | Claude 等待輸入 | `claude-hook-notify.js waiting` → Email + Desktop |
| **PermissionRequest** | 需要權限審批 | `claude-hook-notify.js waiting` → Email + Desktop |

所有 hooks 設定在 `~/.claude/settings.json`，全域生效。

## 日常使用

### 收通知

無需額外操作。Claude Code session 結束時自動發送 Email，內容包含：
- 你的問題（第一條 user message）
- Claude 的回覆（最後一條 assistant message）
- Execution trace（最後 50 條訊息摘要）

### 回覆 Email 下指令

**前提**：Relay 服務必須在背景運行。

1. 收到通知 Email（subject 含 `[Claude-Code-Remote #TOKEN]`）
2. 直接回覆該 Email，body 寫入指令
3. Relay 收到後自動貼上到前景 Terminal

## Relay 服務管理

### 啟動

```bash
cd ~/.claude/Claude-Code-Remote
nohup node src/relay/relay-pty.js > src/data/relay.log 2>&1 &
```

### 停止

```bash
pkill -f "relay-pty.js"
```

### 查看狀態

```bash
# 確認 process 存活
ps aux | grep relay-pty | grep -v grep

# 查看 log
tail -20 ~/.claude/Claude-Code-Remote/src/data/relay.log
```

### 重開機後重啟

Relay 不會自動啟動。重開機後需手動執行啟動指令。

如需開機自動啟動，可加入 macOS LaunchAgent：

```bash
cat > ~/Library/LaunchAgents/com.claude-code-remote.relay.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-code-remote.relay</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/yveschen/.claude/Claude-Code-Remote/src/relay/relay-pty.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/yveschen/.claude/Claude-Code-Remote</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/yveschen/.claude/Claude-Code-Remote/src/data/relay.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/yveschen/.claude/Claude-Code-Remote/src/data/relay.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-code-remote.relay.plist
```

## 本地改動（相對於上游）

| 檔案 | 改動 | 原因 |
|------|------|------|
| `claude-hook-notify.js` | 讀取 stdin transcript，提取真實對話內容 | 原版只支援 tmux，不讀 Claude Code 的 stdin |
| `src/relay/relay-pty.js` | 啟動時只掃近 24h 的 Claude-Code-Remote 信件 | 原版掃全部 UNSEEN，信箱量大時啟動卡死 |

> 上游更新時注意這兩個檔案的 merge conflict。

## Troubleshooting

### Email 內容是空模板

確認 `claude-hook-notify.js` 是否為改寫版（應包含 `readStdin` 和 `parseTranscript` 函式）。

### Relay 啟動後卡住不動

確認 `processExistingEmails` 函式是否有 `['SUBJECT', 'Claude-Code-Remote']` 過濾條件。

### AppleScript 注入失敗

macOS 需要授權 Terminal 的輔助使用權限：
System Settings → Privacy & Security → Accessibility → 勾選 Terminal（或 iTerm）。

### Email 發送失敗

確認 Gmail App Password 有效：
```bash
cd ~/.claude/Claude-Code-Remote && node -e "
require('dotenv').config();
const n = require('nodemailer');
const t = n.createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
t.verify().then(() => console.log('SMTP OK')).catch(e => console.error('SMTP FAIL:', e.message));
"
```
