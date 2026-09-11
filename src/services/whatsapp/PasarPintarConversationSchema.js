const INTENTS = [
    'GENERAL_CHAT',
    'PRODUCT_SEARCH',
    'CATEGORY_SEARCH',
    'PRODUCT_RECOMMENDATION',
    'PRODUCT_DETAIL',
    'PRODUCT_IMAGE',
    'PRODUCT_SELECTION',
    'ADD_TO_CART',
    'UPDATE_QUANTITY',
    'REMOVE_FROM_CART',
    'VIEW_CART',
    'ORDER_CONFIRMATION',
    'ORDER_CANCEL',
    'ORDER_STATUS',
    'FULFILLMENT_SELECTION',
    'PAYMENT_SELECTION',
    'PAYMENT_REQUEST',
    'ADDRESS_UPDATE',
    'FAQ',
    'HUMAN_HELP',
    'UNKNOWN'
];

const ACTION_TYPES = [
    'SELECT_PRODUCT',
    'SELECT_VARIANT',
    'SET_QUANTITY',
    'ADD_PRODUCT',
    'REMOVE_PRODUCT',
    'SHOW_PRODUCT',
    'SHOW_IMAGE',
    'SHOW_CART',
    'SET_FULFILLMENT',
    'SET_PAYMENT',
    'SET_ADDRESS',
    'CONFIRM_ORDER',
    'CANCEL_ORDER'
];

const actionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        type: {
            type: 'string',
            enum: ACTION_TYPES
        },

        productQuery: {
            type: ['string', 'null']
        },

        variant: {
            type: ['string', 'null']
        },

        quantity: {
            type: ['integer', 'null'],
            minimum: 1
        },

        selectionNumber: {
            type: ['integer', 'null'],
            minimum: 1
        },

        fulfillment: {
            type: ['string', 'null'],
            enum: [
                'DELIVERY',
                'PICKUP',
                null
            ]
        },

        paymentPreference: {
            type: ['string', 'null'],
            enum: [
                'ONLINE',
                'OUTLET',
                null
            ]
        },

        addressText: {
            type: ['string', 'null']
        }
    },

    required: [
        'type',
        'productQuery',
        'variant',
        'quantity',
        'selectionNumber',
        'fulfillment',
        'paymentPreference',
        'addressText'
    ]
};

const schema = {
    type: 'object',
    additionalProperties: false,

    properties: {
        primaryIntent: {
            type: 'string',
            enum: INTENTS
        },
        conversationStyle: {
            type: 'object',
            additionalProperties: false,
            properties: {
                language: {
                    type: 'string'
                },
                catalogIntro: {
                    type: 'string'
                },
                catalogOutro: {
                    type: 'string'
                },
                notFoundText: {
                    type: 'string'
                },
                generalReply: {
                    type: 'string'
                },
                cartAddedText: {
                    type: 'string'
                },
                cartRemovedText: {
                    type: 'string'
                },
                cartQuantityUpdatedText: {
                    type: 'string'
                },
                cartViewText: {
                    type: 'string'
                },
                cartEmptyText: {
                    type: 'string'
                },
                cartClarificationText: {
                    type: 'string'
                }
            },
            required: [
                'language',
                'catalogIntro',
                'catalogOutro',
                'notFoundText',
                'generalReply',
                'cartAddedText',
                'cartRemovedText',
                'cartQuantityUpdatedText',
                'cartViewText',
                'cartEmptyText',
                'cartClarificationText'
            ]
        },

        actions: {
            type: 'array',
            items: actionSchema,
            maxItems: 8
        },

        productQuery: {
            type: ['string', 'null']
        },

        categoryQuery: {
            type: ['string', 'null']
        },

        variant: {
            type: ['string', 'null']
        },

        quantity: {
            type: ['integer', 'null'],
            minimum: 1
        },

        selectionNumber: {
            type: ['integer', 'null'],
            minimum: 1
        },

        budgetMin: {
            type: ['number', 'null'],
            minimum: 0
        },

        budgetMax: {
            type: ['number', 'null'],
            minimum: 0
        },

        sortPreference: {
            type: ['string', 'null'],
            enum: [
                'CHEAPEST',
                'MOST_EXPENSIVE',
                'MOST_RELEVANT',
                null
            ]
        },

        spicyPreference: {
            type: ['string', 'null'],
            enum: [
                'SPICY',
                'NOT_SPICY',
                'ANY',
                null
            ]
        },

        fulfillment: {
            type: ['string', 'null'],
            enum: [
                'DELIVERY',
                'PICKUP',
                null
            ]
        },

        paymentPreference: {
            type: ['string', 'null'],
            enum: [
                'ONLINE',
                'OUTLET',
                null
            ]
        },

        referenceToPrevious: {
            type: 'boolean'
        },

        customerCorrection: {
            type: 'boolean'
        },

        needsClarification: {
            type: 'boolean'
        },

        clarificationQuestion: {
            type: ['string', 'null']
        },

        confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1
        }
    },

    required: [
        'primaryIntent',
        'conversationStyle',
        'actions',
        'productQuery',
        'categoryQuery',
        'variant',
        'quantity',
        'selectionNumber',
        'budgetMin',
        'budgetMax',
        'sortPreference',
        'spicyPreference',
        'fulfillment',
        'paymentPreference',
        'referenceToPrevious',
        'customerCorrection',
        'needsClarification',
        'clarificationQuestion',
        'confidence'
    ]
};

module.exports = {
    INTENTS,
    ACTION_TYPES,
    actionSchema,
    schema
};
