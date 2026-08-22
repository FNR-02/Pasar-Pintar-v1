class WhatsAppMessageParser {
    parse(data = {}) {
        const key = data.key || {};
        const message = data.message || {};

        const messageId =
            key.id ||
            data.id ||
            null;

        const messageType =
            data.messageType ||
            Object.keys(message)[0] ||
            null;

        let text = null;

        if (
            typeof message.conversation === 'string'
        ) {
            text = message.conversation;
        } else if (
            typeof message.extendedTextMessage?.text === 'string'
        ) {
            text = message.extendedTextMessage.text;
        } else if (
            typeof message.imageMessage?.caption === 'string'
        ) {
            text = message.imageMessage.caption;
        } else if (
            typeof message.videoMessage?.caption === 'string'
        ) {
            text = message.videoMessage.caption;
        }

        const rawTimestamp =
            data.messageTimestamp ??
            null;

        const timestamp =
            rawTimestamp !== null
                ? Number(rawTimestamp)
                : null;

        return {
            messageId,
            messageType,
            text:
                typeof text === 'string'
                    ? text.trim()
                    : null,
            timestamp:
                Number.isFinite(timestamp)
                    ? timestamp
                    : null
        };
    }
}

module.exports = WhatsAppMessageParser;
