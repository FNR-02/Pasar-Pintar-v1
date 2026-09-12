'use strict';

require('dotenv').config();

const assert =
    require('assert');

const GeminiAI =
    require(
        '../src/services/whatsapp/PasarPintarGeminiConversationAI'
    );

let passed = 0;
let failed = 0;

function pass(name) {
    passed += 1;
    console.log(`PASS  ${name}`);
}

function fail(name, err) {
    failed += 1;
    console.error(
        `FAIL  ${name}:`,
        err?.message || err
    );
}

function normalizeRetrievalQuery(value) {
    return [
        ...new Set(
            String(value || '')
                .toLowerCase()
                .normalize('NFKD')
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .map(token => token.trim())
                .filter(Boolean)
                .map(token =>
                    token.length > 4 &&
                    token.endsWith('s')
                        ? token.slice(0, -1)
                        : token
                )
        )
    ]
        .sort()
        .join(' ');
}

function findProductAction(understanding) {
    return (
        understanding?.actions || []
    ).find(action =>
        [
            'SHOW_PRODUCT',
            'ADD_PRODUCT'
        ].includes(action?.type)
    ) || null;
}

async function checkCase({
    name,
    text,
    expectedLanguage
}) {
    try {
        const ai =
            new GeminiAI({
                enabled: true,
                maxRetries: 0
            });

        assert.equal(
            ai.isReady(),
            true,
            'Gemini AI tidak ready'
        );

        const result =
            await ai.understand({
                text,
                context: {}
            });

        assert.equal(
            result.status,
            'understood'
        );

        const understanding =
            result.understanding;

        assert.ok(
            understanding &&
            typeof understanding === 'object'
        );

        assert.equal(
            understanding
                ?.conversationStyle
                ?.language,
            expectedLanguage
        );

        const action =
            findProductAction(
                understanding
            );

        assert.ok(
            action,
            'Action produk tidak ditemukan'
        );

        assert.ok(
            String(
                action.productQuery || ''
            ).trim(),
            'productQuery kosong'
        );

        assert.ok(
            String(
                action.retrievalQuery || ''
            ).trim(),
            'retrievalQuery kosong'
        );

        console.log(
            '      language =',
            understanding
                .conversationStyle
                .language
        );

        console.log(
            '      action =',
            action.type
        );

        console.log(
            '      productQuery =',
            action.productQuery
        );

        console.log(
            '      retrievalQuery =',
            action.retrievalQuery
        );

        pass(name);

        return {
            retrievalQuery:
                String(
                    action.retrievalQuery
                )
                    .trim()
                    .toLowerCase(),
            retrievalSignature:
                normalizeRetrievalQuery(
                    action.retrievalQuery
                )
        };
    } catch (err) {
        fail(name, err);
        return null;
    }
}

async function main() {
    console.log(
        '===== WHATSAPP AI LIVE V1 ====='
    );

    if (!process.env.GEMINI_API_KEY) {
        throw new Error(
            'GEMINI_API_KEY tidak tersedia'
        );
    }

    const id =
        await checkCase({
            name:
                'Indonesian product inquiry',
            text:
                'ada dumpling keju?',
            expectedLanguage:
                'id'
        });

    const su =
        await checkCase({
            name:
                'Sundanese product inquiry',
            text:
                'aya dumpling keju?',
            expectedLanguage:
                'su'
        });

    const en =
        await checkCase({
            name:
                'English product inquiry',
            text:
                'do you have cheese dumplings?',
            expectedLanguage:
                'en'
        });

    if (
        id &&
        su &&
        en
    ) {
        try {
            assert.equal(
                id.retrievalSignature,
                su.retrievalSignature
            );

            assert.equal(
                id.retrievalSignature,
                en.retrievalSignature
            );

            pass(
                'Cross-language retrieval query is consistent'
            );
        } catch (err) {
            fail(
                'Cross-language retrieval query is consistent',
                err
            );

            console.error(
                '      ID =',
                id.retrievalQuery
            );
            console.error(
                '      SU =',
                su.retrievalQuery
            );
            console.error(
                '      EN =',
                en.retrievalQuery
            );
        }
    }

    console.log();
    console.log(
        `RESULT ${passed} passed, ${failed} failed`
    );

    if (failed > 0) {
        process.exitCode = 1;
        return;
    }

    console.log(
        'WHATSAPP_AI_LIVE_V1_PASS'
    );
}

main().catch(err => {
    console.error(
        'FATAL:',
        err?.message || err
    );
    process.exitCode = 1;
});
