'use strict';

const assert =
    require('assert');

const Adapter =
    require(
        '../src/services/whatsapp/PasarPintarAIUnderstandingAdapter'
    );

const Executor =
    require(
        '../src/services/whatsapp/PasarPintarAIOperationExecutor'
    );

const ResponseBuilder =
    require(
        '../src/services/whatsapp/PasarPintarAIResponseBuilder'
    );

const {
    actionSchema
} =
    require(
        '../src/services/whatsapp/PasarPintarConversationSchema'
    );

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed += 1;
        console.error(
            `FAIL  ${name}: ${err.message}`
        );
    }
}

function finalResult() {
    console.log();
    console.log(
        `RESULT ${passed} passed, ${failed} failed`
    );

    if (failed > 0) {
        process.exitCode = 1;
        return;
    }

    console.log(
        'WHATSAPP_AI_REGRESSION_V1_PASS'
    );
}

const adapter =
    new Adapter();

const executor =
    Object.create(
        Executor.prototype
    );

const responseBuilder =
    new ResponseBuilder();

/*
 * =====================================================
 * SCHEMA CONTRACT
 * =====================================================
 */

test(
    'Schema requires retrievalQuery',
    () => {
        assert.ok(
            Array.isArray(
                actionSchema.required
            )
        );

        assert.ok(
            actionSchema.required.includes(
                'retrievalQuery'
            )
        );
    }
);

/*
 * =====================================================
 * AI -> BACKEND RETRIEVAL CONTRACT
 * =====================================================
 */

test(
    'ADD_PRODUCT uses semantic retrievalQuery',
    () => {
        const result =
            adapter.adaptAction({
                type: 'ADD_PRODUCT',
                productQuery:
                    'dumpling keju',
                retrievalQuery:
                    'dumpling cheese',
                variant: '500g',
                quantity: 1
            });

        assert.equal(
            result.type,
            'ADD_PRODUCT'
        );

        assert.equal(
            result.productQuery,
            'dumpling cheese'
        );

        assert.equal(
            result.quantity,
            1
        );
    }
);

test(
    'SHOW_PRODUCT uses semantic retrievalQuery',
    () => {
        const result =
            adapter.adaptAction({
                type: 'SHOW_PRODUCT',
                productQuery:
                    'cheese dumplings',
                retrievalQuery:
                    'dumpling cheese',
                variant: null
            });

        assert.equal(
            result.type,
            'LEGACY_INTENT'
        );

        assert.equal(
            result.intent,
            'PRODUCT_INQUIRY'
        );

        assert.equal(
            result.productQuery,
            'dumpling cheese'
        );
    }
);

test(
    'Retrieval query is language independent',
    () => {
        const samples = [
            {
                productQuery:
                    'dumpling keju',
                retrievalQuery:
                    'dumpling cheese'
            },
            {
                productQuery:
                    'dumpling kéju',
                retrievalQuery:
                    'dumpling cheese'
            },
            {
                productQuery:
                    'cheese dumplings',
                retrievalQuery:
                    'dumpling cheese'
            }
        ];

        for (const sample of samples) {
            const result =
                adapter.adaptAction({
                    type:
                        'SHOW_PRODUCT',
                    productQuery:
                        sample.productQuery,
                    retrievalQuery:
                        sample.retrievalQuery,
                    variant: null
                });

            assert.equal(
                result.productQuery,
                'dumpling cheese'
            );
        }
    }
);

/*
 * REMOVE/SET QUANTITY operate on existing cart.
 * They intentionally retain customer/cart query.
 */

test(
    'REMOVE_PRODUCT preserves cart query',
    () => {
        const result =
            adapter.adaptAction({
                type: 'REMOVE_PRODUCT',
                productQuery:
                    'bihun tanam jagung',
                retrievalQuery:
                    'rice vermicelli corn'
            });

        assert.equal(
            result.productQuery,
            'bihun tanam jagung'
        );
    }
);

test(
    'SET_QUANTITY preserves cart query',
    () => {
        const result =
            adapter.adaptAction({
                type: 'SET_QUANTITY',
                productQuery:
                    'dumpling cheese',
                retrievalQuery:
                    'cheese dumpling',
                quantity: 3,
                variant: '500g'
            });

        assert.equal(
            result.productQuery,
            'dumpling cheese'
        );

        assert.equal(
            result.quantity,
            3
        );
    }
);

/*
 * =====================================================
 * CART ITEM RESOLUTION
 * =====================================================
 */

test(
    'Cart token match resolves authoritative product',
    () => {
        const result =
            executor.resolveCartItem({
                query:
                    'bihun tanam jagung',
                variant: null,
                items: [
                    {
                        product_id: '1',
                        product_name:
                            'Bihun Cap Tanam Jagung',
                        quantity: 1
                    },
                    {
                        product_id: '2',
                        product_name:
                            'Andir Kwetiau',
                        quantity: 1
                    }
                ]
            });

        assert.equal(
            result.status,
            'cart_item_resolved'
        );

        assert.equal(
            result.item.product_name,
            'Bihun Cap Tanam Jagung'
        );
    }
);

test(
    'Cart resolver keeps ambiguous products ambiguous',
    () => {
        const result =
            executor.resolveCartItem({
                query:
                    'dumpling cheese',
                variant: null,
                items: [
                    {
                        product_id: '3',
                        product_name:
                            'CEDEA Fish Dumpling Cheese 200Gr',
                        quantity: 1
                    },
                    {
                        product_id: '4',
                        product_name:
                            'CEDEA Fish Dumpling Cheese 500Gr',
                        quantity: 1
                    }
                ]
            });

        assert.equal(
            result.status,
            'cart_item_ambiguous'
        );

        assert.equal(
            result.candidates.length,
            2
        );
    }
);

test(
    'Unknown cart product remains not found',
    () => {
        const result =
            executor.resolveCartItem({
                query:
                    'sosis sapi',
                variant: null,
                items: [
                    {
                        product_id: '1',
                        product_name:
                            'Bihun Cap Tanam Jagung',
                        quantity: 1
                    }
                ]
            });

        assert.equal(
            result.status,
            'cart_item_not_found'
        );
    }
);

/*
 * =====================================================
 * SAFETY PLAN VALIDATION
 * =====================================================
 */

test(
    'DELIVERY plus OUTLET payment is rejected',
    () => {
        const result =
            executor.validatePlan([
                {
                    type:
                        'SET_FULFILLMENT',
                    fulfillment:
                        'DELIVERY'
                },
                {
                    type:
                        'SET_PAYMENT',
                    paymentPreference:
                        'OUTLET'
                }
            ]);

        assert.equal(
            result.valid,
            false
        );

        assert.equal(
            result.reason,
            'outlet_payment_requires_pickup'
        );
    }
);

test(
    'Conflicting fulfillment is rejected',
    () => {
        const result =
            executor.validatePlan([
                {
                    type:
                        'SET_FULFILLMENT',
                    fulfillment:
                        'DELIVERY'
                },
                {
                    type:
                        'SET_FULFILLMENT',
                    fulfillment:
                        'PICKUP'
                }
            ]);

        assert.equal(
            result.valid,
            false
        );

        assert.equal(
            result.reason,
            'conflicting_fulfillment'
        );
    }
);

/*
 * =====================================================
 * MULTI-OPERATION RESPONSE
 * =====================================================
 */

test(
    'Response summarizes add then remove',
    () => {
        const cart = {
            status: 'cart_ready',
            items: [
                {
                    product_name:
                        'Andir Kwetiau',
                    quantity: 2,
                    subtotal: 10000
                }
            ],
            totalAmount: 10000
        };

        const response =
            responseBuilder.build(
                {
                    status:
                        'executed',
                    results: [
                        {
                            operation: {
                                type:
                                    'ADD_PRODUCT'
                            },
                            result: {
                                status:
                                    'product_added_to_cart',
                                productName:
                                    'Bihun Cap Tanam Jagung',
                                quantity: 1,
                                cart
                            }
                        },
                        {
                            operation: {
                                type:
                                    'REMOVE_PRODUCT'
                            },
                            result: {
                                status:
                                    'product_removed_from_cart',
                                productName:
                                    'Bihun Cap Tanam Jagung',
                                cart
                            }
                        }
                    ]
                },
                {
                    conversationLanguage:
                        'id'
                }
            );

        assert.equal(
            response.status,
            'ready'
        );

        assert.ok(
            response.responseText.includes(
                'Bihun Cap Tanam Jagung × 1'
            )
        );

        assert.ok(
            response.responseText.includes(
                'Bihun Cap Tanam Jagung dihapus'
            )
        );

        assert.ok(
            response.responseText.includes(
                'Andir Kwetiau × 2'
            )
        );
    }
);

finalResult();
