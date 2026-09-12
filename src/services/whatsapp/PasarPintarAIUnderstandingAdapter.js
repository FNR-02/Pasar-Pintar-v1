const {
    INTENTS,
    ACTION_TYPES
} = require(
    './PasarPintarConversationSchema'
);

class PasarPintarAIUnderstandingAdapter {
    constructor({
        minimumConfidence = 0.60
    } = {}) {
        this.minimumConfidence =
            Number(minimumConfidence);
    }

    normalize(value) {
        return String(value || '')
            .trim()
            .toUpperCase();
    }

    adapt(understanding) {
        if (
            !understanding ||
            typeof understanding !== 'object'
        ) {
            return {
                status: 'invalid_understanding',
                operations: []
            };
        }

        const primaryIntent =
            this.normalize(
                understanding.primaryIntent
            );

        if (!INTENTS.includes(primaryIntent)) {
            return {
                status: 'invalid_intent',
                primaryIntent,
                operations: []
            };
        }

        const confidence =
            Number(
                understanding.confidence || 0
            );

        if (
            !Number.isFinite(confidence) ||
            confidence <
                this.minimumConfidence
        ) {
            return {
                status: 'low_confidence',
                primaryIntent,
                confidence,
                operations: []
            };
        }

        if (
            understanding.needsClarification ===
                true
        ) {
            const question =
                String(
                    understanding
                        .clarificationQuestion ||
                    ''
                ).trim();

            return {
                status: 'clarification_required',
                primaryIntent,
                confidence,
                question:
                    question ||
                    'Boleh dijelasin sedikit lagi maksudnya?',
                operations: []
            };
        }

        const actions =
            Array.isArray(
                understanding.actions
            )
                ? understanding.actions
                : [];

        const operations = [];

        for (const action of actions) {
            const operation =
                this.adaptAction(action);

            if (operation) {
                operations.push(operation);
            }
        }

        /*
         * Beberapa intent read-only / command sederhana
         * boleh diterjemahkan langsung ke intent legacy.
         *
         * Transaction-sensitive multi-action tetap
         * dipertahankan sebagai operation dan belum
         * dieksekusi di sini.
         */
        if (operations.length === 0) {
            const legacyIntent =
                this.mapPrimaryIntent(
                    primaryIntent
                );

            if (legacyIntent) {
                operations.push({
                    type: 'LEGACY_INTENT',
                    intent: legacyIntent,
                    mutating: false
                });
            }
        }

        const semanticCatalogIntents =
            new Set([
                'PRODUCT_SEARCH',
                'CATEGORY_SEARCH',
                'PRODUCT_RECOMMENDATION'
            ]);

        const showProductAction =
            actions.find(
                action =>
                    this.normalize(
                        action?.type
                    ) === 'SHOW_PRODUCT'
            ) || null;

        const catalogRequested =
            semanticCatalogIntents.has(
                primaryIntent
            ) ||
            Boolean(showProductAction);

        const catalogRequest =
            catalogRequested
                ? {
                    productQuery:
                        this.cleanText(
                            showProductAction
                                ?.productQuery
                        ) ??
                        understanding
                            .productQuery ??
                        null,
                    categoryQuery:
                        understanding
                            .categoryQuery ??
                        null,
                    budgetMin:
                        understanding
                            .budgetMin ??
                        null,
                    budgetMax:
                        understanding
                            .budgetMax ??
                        null,
                    sortPreference:
                        understanding
                            .sortPreference ??
                        null,
                    spicyPreference:
                        understanding
                            .spicyPreference ??
                        null
                }
                : null;

        return {
            status: 'adapted',
            primaryIntent,
            confidence,
            referenceToPrevious:
                understanding
                    .referenceToPrevious === true,
            customerCorrection:
                understanding
                    .customerCorrection === true,
            catalogRequest:
                (() => {
                    /*
                     * SHOW_PRODUCT sudah dinormalisasi
                     * secara semantik oleh AI.
                     *
                     * Jangan buang query tersebut lalu
                     * kembali memakai teks mentah customer.
                     */
                    const showProduct =
                        operations.find(
                            operation =>
                                operation?.type ===
                                    'LEGACY_INTENT' &&
                                operation?.intent ===
                                    'PRODUCT_INQUIRY' &&
                                operation?.productQuery
                        );

                    if (!showProduct) {
                        return catalogRequest;
                    }

                    return {
                        ...(catalogRequest || {}),
                        productQuery:
                            showProduct.productQuery
                    };
                })(),
            operations
        };
    }

    mapPrimaryIntent(intent) {
        const mapping = {
            GENERAL_CHAT:
                'AI_GENERAL_CHAT',

            PRODUCT_SEARCH:
                'PRODUCT_INQUIRY',
            CATEGORY_SEARCH:
                'PRODUCT_INQUIRY',
            PRODUCT_RECOMMENDATION:
                'PRODUCT_INQUIRY',
            PRODUCT_DETAIL:
                'PRODUCT_INQUIRY',

            PRODUCT_IMAGE:
                'PRODUCT_IMAGE',

            VIEW_CART:
                null,

            ORDER_CONFIRMATION:
                'ORDER_CONFIRMATION',

            ORDER_CANCEL:
                'ORDER_CANCEL',

            ORDER_STATUS:
                'ORDER_STATUS',

            ADDRESS_UPDATE:
                'ADDRESS_UPDATE'
        };

        return mapping[intent] || null;
    }

    adaptAction(action) {
        if (
            !action ||
            typeof action !== 'object'
        ) {
            return null;
        }

        const type =
            this.normalize(action.type);

        if (!ACTION_TYPES.includes(type)) {
            return null;
        }

        switch (type) {
            case 'SELECT_PRODUCT':
                return {
                    type,
                    selectionNumber:
                        this.positiveInteger(
                            action.selectionNumber
                        ),
                    productQuery:
                        this.cleanText(
                            action.productQuery
                        ),
                    requiresContextValidation:
                        true,
                    mutating: true
                };

            case 'SELECT_VARIANT':
                return {
                    type,
                    variant:
                        this.cleanText(
                            action.variant
                        ),
                    productQuery:
                        this.cleanText(
                            action.productQuery
                        ),
                    requiresContextValidation:
                        true,
                    mutating: true
                };

            case 'SET_QUANTITY':
                return {
                    type,
                    productQuery:
                        this.cleanText(
                            action.productQuery
                        ),
                    variant:
                        this.cleanText(
                            action.variant
                        ),
                    quantity:
                        this.positiveInteger(
                            action.quantity
                        ),
                    /*
                     * productQuery/variant memungkinkan
                     * quantity diarahkan ke item cart
                     * tertentu. Draft validation tetap
                     * dipertahankan untuk kompatibilitas
                     * jalur single-product lama.
                     */
                    requiresDraftValidation:
                        true,
                    mutating: true
                };

            case 'ADD_PRODUCT':
                return {
                    type,
                    productQuery:
                        this.cleanText(
                            action.retrievalQuery
                        ) ??
                        this.cleanText(
                            action.productQuery
                        ),
                    variant:
                        this.cleanText(
                            action.variant
                        ),
                    quantity:
                        this.positiveInteger(
                            action.quantity
                        ),
                    requiresCatalogValidation:
                        true,
                    mutating: true
                };

            case 'REMOVE_PRODUCT':
                return {
                    type,
                    productQuery:
                        this.cleanText(
                            action.productQuery
                        ),
                    requiresDraftValidation:
                        true,
                    mutating: true
                };

            case 'SHOW_PRODUCT':
                return {
                    type: 'LEGACY_INTENT',
                    intent:
                        'PRODUCT_INQUIRY',
                    productQuery:
                        this.cleanText(
                            action.retrievalQuery
                        ) ??
                        this.cleanText(
                            action.productQuery
                        ),
                    variant:
                        this.cleanText(
                            action.variant
                        ),
                    mutating: false
                };

            case 'SHOW_IMAGE':
                return {
                    type: 'LEGACY_INTENT',
                    intent:
                        'PRODUCT_IMAGE',
                    mutating: false
                };

            case 'SHOW_CART':
                return {
                    type: 'SHOW_CART',
                    requiresDraftValidation:
                        true,
                    mutating: false
                };

            case 'SET_FULFILLMENT': {
                const fulfillment =
                    this.normalize(
                        action.fulfillment
                    );

                if (
                    ![
                        'PICKUP',
                        'DELIVERY'
                    ].includes(
                        fulfillment
                    )
                ) {
                    return null;
                }

                return {
                    type,
                    fulfillment,
                    legacyIntent:
                        fulfillment ===
                            'PICKUP'
                            ? 'FULFILLMENT_PICKUP'
                            : 'FULFILLMENT_DELIVERY',
                    requiresDraftValidation:
                        true,
                    mutating: true
                };
            }

            case 'SET_PAYMENT': {
                const paymentPreference =
                    this.normalize(
                        action
                            .paymentPreference
                    );

                if (
                    ![
                        'OUTLET',
                        'ONLINE'
                    ].includes(
                        paymentPreference
                    )
                ) {
                    return null;
                }

                return {
                    type,
                    paymentPreference,
                    /*
                     * PAYMENT tidak langsung dipetakan
                     * ke handler karena ONLINE bergantung
                     * pada fulfillment draft saat ini.
                     */
                    requiresDraftContext:
                        true,
                    mutating: true
                };
            }

            case 'SET_ADDRESS':
                return {
                    type,
                    addressText:
                        this.cleanText(
                            action.addressText
                        ),
                    requiresDraftValidation:
                        true,
                    mutating: true
                };

            case 'CONFIRM_ORDER':
                return {
                    type,
                    legacyIntent:
                        'ORDER_CONFIRMATION',
                    requiresDraftValidation:
                        true,
                    mutating: true
                };

            case 'CANCEL_ORDER':
                return {
                    type,
                    legacyIntent:
                        'ORDER_CANCEL',
                    requiresDraftValidation:
                        true,
                    mutating: true
                };

            default:
                return null;
        }
    }

    cleanText(value) {
        const text =
            String(value || '').trim();

        return text || null;
    }

    positiveInteger(value) {
        const number =
            Number(value);

        if (
            !Number.isInteger(number) ||
            number < 1
        ) {
            return null;
        }

        return number;
    }
}

module.exports =
    PasarPintarAIUnderstandingAdapter;
