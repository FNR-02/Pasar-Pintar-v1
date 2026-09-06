class GreetingHandler {
    handle({ customer, text }) {
        const fullName =
            String(
                customer?.full_name || ''
            ).trim();

        const firstName =
            fullName
                .split(/\s+/)
                .filter(Boolean)[0] || '';

        const message =
            String(text || '')
                .trim()
                .toLowerCase();

        let greeting = 'Halo';

        if (
            message.includes('assalamualaikum') ||
            message.includes("assalamu'alaikum")
        ) {
            greeting = 'Waalaikumsalam';
        } else if (
            /\b(pagi|selamat pagi)\b/.test(message)
        ) {
            greeting = 'Pagi';
        } else if (
            /\b(siang|selamat siang)\b/.test(message)
        ) {
            greeting = 'Siang';
        } else if (
            /\b(sore|selamat sore)\b/.test(message)
        ) {
            greeting = 'Sore';
        } else if (
            /\b(malam|selamat malam)\b/.test(message)
        ) {
            greeting = 'Malam';
        } else if (
            /\bhallo\b/.test(message)
        ) {
            greeting = 'Hallo';
        }

        const nameText =
            firstName
                ? ` kak ${firstName}`
                : ' kak';

        return {
            status: 'ready',
            responseText:
                `${greeting}${nameText} 👋\n` +
                'Ada yang mau ditanyakan atau dipesan di Pasar Pintar?'
        };
    }
}

module.exports = GreetingHandler;
