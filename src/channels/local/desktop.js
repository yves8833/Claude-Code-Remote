/**
 * Desktop Notification Channel
 * Sends notifications to the local desktop
 */

const NotificationChannel = require('../base/channel');
const { execSync, execFileSync, spawn } = require('child_process');
const path = require('path');

class DesktopChannel extends NotificationChannel {
    constructor(config = {}) {
        super('desktop', config);
        this.platform = process.platform;
        this.soundsDir = path.join(__dirname, '../../assets/sounds');
    }

    async _sendImpl(notification) {
        const { title, message } = notification;
        const sound = this._getSoundForType(notification.type);

        switch (this.platform) {
            case 'darwin':
                return this._sendMacOS(title, message, sound);
            case 'linux':
                return this._sendLinux(title, message, sound);
            case 'win32':
                return this._sendWindows(title, message, sound);
            default:
                this.logger.warn(`Platform ${this.platform} not supported`);
                return false;
        }
    }

    _getSoundForType(type) {
        const soundMap = {
            completed: this.config.completedSound || 'Glass',
            waiting: this.config.waitingSound || 'Glass'
        };
        return soundMap[type] || 'Glass';
    }

    _sendMacOS(title, message, sound) {
        const timeout = parseInt(process.env.NOTIFICATION_TIMEOUT) || 3000;
        // Truncate message to avoid overly long notifications
        const safeMessage = (message || '').substring(0, 500);
        try {
            // Try terminal-notifier first — use execFileSync to avoid shell interpretation
            // of backticks, $(), and other special characters in message content
            try {
                execFileSync('terminal-notifier', [
                    '-title', title,
                    '-message', safeMessage,
                    '-sound', 'default',
                    '-group', 'claude-code-remote'
                ], { timeout });
            } catch (e) {
                // Fallback to osascript — escape backslashes and quotes for AppleScript
                const escTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const escMessage = safeMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                execFileSync('osascript', [
                    '-e', `display notification "${escMessage}" with title "${escTitle}"`
                ], { timeout });
            }
            // Always play sound independently via afplay so it's audible even over music
            this._playSound(sound);
            return true;
        } catch (error) {
            this.logger.error('macOS notification failed:', error.message);
            return false;
        }
    }

    _sendLinux(title, message, sound) {
        try {
            const notificationTimeout = parseInt(process.env.NOTIFICATION_TIMEOUT) || 3000;
            const displayTime = parseInt(process.env.NOTIFICATION_DISPLAY_TIME) || 10000;
            const safeMessage = (message || '').substring(0, 500);
            execFileSync('notify-send', [title, safeMessage, '-t', String(displayTime)], { timeout: notificationTimeout });
            this._playSound(sound);
            return true;
        } catch (error) {
            this.logger.error('Linux notification failed:', error.message);
            return false;
        }
    }

    _sendWindows(title, message, sound) {
        try {
            const script = `
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
            $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
            $xml = [xml] $template.GetXml()
            $xml.toast.visual.binding.text[0].AppendChild($xml.CreateTextNode("${title}")) > $null
            $xml.toast.visual.binding.text[1].AppendChild($xml.CreateTextNode("${message}")) > $null
            $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude-Code-Remote").Show($toast)
            `;
            
            execSync(`powershell -Command "${script}"`, { timeout: 5000 });
            this._playSound(sound);
            return true;
        } catch (error) {
            this.logger.error('Windows notification failed:', error.message);
            return false;
        }
    }

    _playSound(soundName) {
        if (!soundName || soundName === 'default') return;

        try {
            if (this.platform === 'darwin') {
                const soundPath = `/System/Library/Sounds/${soundName}.aiff`;
                const volume = String(this.config.volume || 2);
                const audioProcess = spawn('afplay', ['-v', volume, soundPath], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            } else if (this.platform === 'linux') {
                const soundPath = `/usr/share/sounds/freedesktop/stereo/${soundName.toLowerCase()}.oga`;
                const audioProcess = spawn('paplay', [soundPath], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            } else if (this.platform === 'win32') {
                const audioProcess = spawn('powershell', ['-c', `[console]::beep(800,300)`], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            }
        } catch (error) {
            this.logger.debug('Sound playback failed:', error.message);
        }
    }

    validateConfig() {
        // Desktop notifications don't require configuration
        return true;
    }

    getAvailableSounds() {
        const sounds = {
            'System Sounds': ['Glass', 'Tink', 'Ping', 'Pop', 'Basso', 'Blow', 'Bottle', 
                            'Frog', 'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine'],
            'Alert Sounds': ['Beep', 'Boop', 'Sosumi', 'Tink', 'Glass'],
            'Nature Sounds': ['Frog', 'Submarine'],
            'Musical Sounds': ['Funk', 'Hero', 'Morse', 'Sosumi']
        };

        // Add custom sounds from assets directory
        try {
            const fs = require('fs');
            if (fs.existsSync(this.soundsDir)) {
                const customSounds = fs.readdirSync(this.soundsDir)
                    .filter(file => /\.(wav|mp3|m4a|aiff|ogg)$/i.test(file))
                    .map(file => path.basename(file, path.extname(file)));
                
                if (customSounds.length > 0) {
                    sounds['Custom Sounds'] = customSounds;
                }
            }
        } catch (error) {
            this.logger.debug('Failed to load custom sounds:', error.message);
        }

        return sounds;
    }
}

module.exports = DesktopChannel;