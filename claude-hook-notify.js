#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks to send notifications via Email/Telegram/Desktop.
 * Reads transcript data from stdin (passed by Claude Code hooks).
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables from the project directory
const scriptDir = path.dirname(__filename);
const envPath = path.join(scriptDir, '.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    console.error('❌ .env file not found at:', envPath);
    process.exit(1);
}

const DesktopChannel = require('./src/channels/local/desktop');
const EmailChannel = require('./src/channels/email/smtp');

/**
 * Read stdin (Claude Code passes JSON with transcript_path, session_id, etc.)
 */
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => {
            process.stdin.destroy();
            resolve(data);
        }, 3000);

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            resolve(data);
        });
        process.stdin.on('error', () => {
            clearTimeout(timeout);
            resolve(data);
        });
        process.stdin.resume();
    });
}

/**
 * Parse Claude Code JSONL transcript and extract conversation content.
 */
function parseTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return { userQuestion: null, claudeResponse: null, fullTrace: null };
    }

    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
        try { messages.push(JSON.parse(line)); } catch { /* skip */ }
    }

    if (messages.length === 0) {
        return { userQuestion: null, claudeResponse: null, fullTrace: null };
    }

    // Extract first user message
    let userQuestion = null;
    for (const msg of messages) {
        if (msg.type === 'human') {
            const content = msg.message?.content;
            if (typeof content === 'string') {
                userQuestion = content;
            } else if (Array.isArray(content)) {
                const textPart = content.find(p => p.type === 'text');
                if (textPart) userQuestion = textPart.text;
            }
            if (userQuestion) break;
        }
    }

    // Extract last assistant message
    let claudeResponse = null;
    for (const msg of [...messages].reverse()) {
        if (msg.type === 'assistant') {
            const content = msg.message?.content;
            if (typeof content === 'string') {
                claudeResponse = content;
            } else if (Array.isArray(content)) {
                const textParts = content
                    .filter(p => p.type === 'text')
                    .map(p => p.text);
                if (textParts.length > 0) claudeResponse = textParts.join('\n');
            }
            if (claudeResponse) break;
        }
    }

    // Build execution trace (last 50 messages summary)
    const traceMessages = messages.slice(-50);
    const traceLines = [];
    for (const msg of traceMessages) {
        const role = msg.type === 'human' ? 'USER' : msg.type === 'assistant' ? 'CLAUDE' : msg.type;
        const content = msg.message?.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            text = content
                .filter(p => p.type === 'text')
                .map(p => p.text)
                .join('\n');
            // Include tool use summaries
            const toolUses = content.filter(p => p.type === 'tool_use');
            for (const tu of toolUses) {
                text += `\n[Tool: ${tu.name}]`;
            }
            const toolResults = content.filter(p => p.type === 'tool_result');
            for (const tr of toolResults) {
                text += `\n[Tool Result: ${typeof tr.content === 'string' ? tr.content.substring(0, 200) : '...'}]`;
            }
        }
        if (text) {
            // Truncate long messages in trace
            const truncated = text.length > 500 ? text.substring(0, 500) + '...' : text;
            traceLines.push(`[${role}] ${truncated}`);
        }
    }

    // Truncate response for email (keep first 2000 chars)
    if (claudeResponse && claudeResponse.length > 2000) {
        claudeResponse = claudeResponse.substring(0, 2000) + '\n\n... (truncated)';
    }

    return {
        userQuestion,
        claudeResponse,
        fullTrace: traceLines.join('\n\n---\n\n') || null
    };
}

async function sendHookNotification() {
    try {
        const notificationType = process.argv[2] || 'completed';

        // Read stdin from Claude Code hooks
        const stdinData = await readStdin();
        let hookInput = {};
        if (stdinData) {
            try { hookInput = JSON.parse(stdinData); } catch { /* not JSON */ }
        }

        // Parse transcript if available
        const { userQuestion, claudeResponse, fullTrace } = parseTranscript(hookInput.transcript_path);

        const channels = [];
        const results = [];

        // Desktop channel (always enabled)
        channels.push({
            name: 'Desktop',
            channel: new DesktopChannel({ completedSound: 'Glass', waitingSound: 'Tink' })
        });

        // Telegram channel
        if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
            const TelegramChannel = require('./src/channels/telegram/telegram');
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                groupId: process.env.TELEGRAM_GROUP_ID
            };
            if (telegramConfig.botToken && (telegramConfig.chatId || telegramConfig.groupId)) {
                channels.push({ name: 'Telegram', channel: new TelegramChannel(telegramConfig) });
            }
        }

        // Email channel
        if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
            const emailConfig = {
                smtp: {
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                },
                from: process.env.EMAIL_FROM,
                fromName: process.env.EMAIL_FROM_NAME,
                to: process.env.EMAIL_TO
            };
            if (emailConfig.smtp.host && emailConfig.smtp.auth.user && emailConfig.to) {
                channels.push({ name: 'Email', channel: new EmailChannel(emailConfig) });
            }
        }

        const projectName = path.basename(process.cwd());

        // Create notification with real conversation content
        const notification = {
            type: notificationType,
            title: `Claude ${notificationType === 'completed' ? 'Task Completed' : 'Waiting for Input'}`,
            message: claudeResponse || `Claude has ${notificationType === 'completed' ? 'completed a task' : 'is waiting for input'}`,
            project: projectName,
            metadata: {
                userQuestion: userQuestion || 'No specified task',
                claudeResponse: claudeResponse || 'No response captured',
                fullExecutionTrace: fullTrace || 'No execution trace available.',
                sessionId: hookInput.session_id || null
            }
        };

        // Send to all channels
        for (const { name, channel } of channels) {
            try {
                const result = await channel.send(notification);
                results.push({ name, success: result });
                if (result) {
                    console.log(`✅ ${name} sent`);
                }
            } catch (error) {
                console.error(`❌ ${name}: ${error.message}`);
                results.push({ name, success: false });
            }
        }

        const successful = results.filter(r => r.success).length;
        if (successful === 0) {
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Hook error:', error.message);
        process.exit(1);
    }
}

sendHookNotification();