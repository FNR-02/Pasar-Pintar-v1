class WhatsAppTextNormalizer {
    normalize(text) {
        let value =
            String(text || '')
                .trim()
                .toLowerCase();

        value =
            value
                .replace(/[ \t]+/g, ' ')
                .replace(/\s+([?!.,])/g, '$1')
                .trim();

        const exactWords = {
            hallo: 'halo',
            halloo: 'halo',
            hallooo: 'halo',
            helloo: 'hello',
            hellooo: 'hello',

            assalamualaikum: 'assalamualaikum',
            "assalamu'alaikum": 'assalamualaikum',

            yg: 'yang',
            brp: 'berapa',
            hrg: 'harga',
            harganya: 'harganya',
            gk: 'nggak',
            ga: 'nggak',
            gak: 'nggak',
            nggk: 'nggak',

            gambarr: 'gambar',
            gambarnyaa: 'gambarnya',
            fotto: 'foto',
            fotonyaa: 'fotonya',

            stokk: 'stok',
            stoknyaa: 'stoknya',

            /*
             * Sunda conversational aliases.
             *
             * Dibuat sempit untuk kata yang maknanya
             * jelas dalam percakapan belanja.
             */
            meser: 'beli',
            hiji: 'satu',
            ningal: 'lihat',
            tingali: 'lihat',
            fotona: 'fotonya',
            gambarna: 'gambarnya',
            we: 'aja',
            weh: 'aja',
            totalna: 'totalnya',
            janten: 'jadi',
            sabaraha: 'berapa',
            sbraha: 'berapa'
        };

        value =
            value
                .split(' ')
                .map(token => {
                    const match =
                        token.match(
                            /^([^a-z0-9']*)([a-z0-9']+)([^a-z0-9']*)$/i
                        );

                    if (!match) {
                        return token;
                    }

                    const word = match[2];

                    return (
                        match[1] +
                        (exactWords[word] || word) +
                        match[3]
                    );
                })
                .join(' ');

        return value;
    }
}

module.exports = WhatsAppTextNormalizer;
