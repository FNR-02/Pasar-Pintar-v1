class PasarPintarAIResponseBuilder {
    normalizeLanguage(value) {
        const language =
            String(value || '')
                .trim()
                .toLowerCase();

        return ['id', 'su', 'en']
            .includes(language)
                ? language
                : 'id';
    }

    text(language, key) {
        const copy = {
            id: {
                cartEmpty:
                    'Keranjang belanja masih kosong ya.',
                cartNow:
                    'Keranjang kamu sekarang:',
                added:
                    'Siap, produknya sudah masuk keranjang.',
                removed:
                    'Produknya sudah dihapus dari keranjang.',
                quantityUpdated:
                    'Siap, jumlah produknya sudah diperbarui.',
                total:
                    'Total',
                clarification:
                    'Ada produk yang masih perlu diperjelas sebelum bisa dimasukkan.'
            },
            su: {
                cartEmpty:
                    'Karanjang balanja masih kosong.',
                cartNow:
                    'Eusi karanjang ayeuna:',
                added:
                    'Siap, produkna parantos diasupkeun kana karanjang.',
                removed:
                    'Produkna parantos dipiceun tina karanjang.',
                quantityUpdated:
                    'Siap, jumlah produkna parantos dirobih.',
                total:
                    'Jumlah',
                clarification:
                    'Aya produk anu masih kedah diperjelas sateuacan tiasa diasupkeun.'
            },
            en: {
                cartEmpty:
                    'Your cart is still empty.',
                cartNow:
                    'Your cart now:',
                added:
                    'Done, the product has been added to your cart.',
                removed:
                    'The product has been removed from your cart.',
                quantityUpdated:
                    'Done, the product quantity has been updated.',
                total:
                    'Total',
                clarification:
                    'One or more products still need clarification before they can be added.'
            }
        };

        return copy[language]?.[key] ||
            copy.id[key];
    }

    sanitizeNaturalStyle(value) {
        const text =
            String(value || '')
                .replace(/[\r\n]+/g, ' ')
                .trim();

        if (
            !text ||
            text.length > 180 ||
            /\d/.test(text) ||
            /(?:\brp\b|idr|rupiah|\$|€|£)/i.test(text)
        ) {
            return null;
        }

        return text;
    }

    build(execution, {
        conversationLanguage = null,
        conversationStyle = null
    } = {}) {
        const language =
            this.normalizeLanguage(
                conversationLanguage
            );

        const style =
            conversationStyle &&
            typeof conversationStyle === 'object'
                ? conversationStyle
                : {};

        const natural = (
            key,
            fallbackKey
        ) =>
            this.sanitizeNaturalStyle(
                style[key]
            ) ||
            this.text(
                language,
                fallbackKey
            );
        if (
            !execution ||
            ![
                'executed',
                'executed_with_clarification'
            ].includes(execution.status) ||
            !Array.isArray(execution.results) ||
            execution.results.length === 0
        ) {
            return {
                status: 'response_unavailable',
                responseText: null
            };
        }

        const results =
            execution.results;

        /*
         * =====================================================
         * WHATSAPP CART RESPONSE
         * =====================================================
         *
         * AI hanya memahami maksud.
         * Semua nama produk, quantity dan total di bawah
         * berasal dari hasil backend authoritative.
         */
        const cartOperationTypes =
            new Set([
                'ADD_PRODUCT',
                'REMOVE_PRODUCT',
                'SET_QUANTITY',
                'SHOW_CART'
            ]);

        const cartResults =
            results.filter(item =>
                cartOperationTypes.has(
                    item?.operation?.type
                )
            );

        if (cartResults.length > 0) {
            const lastCartResult =
                [...cartResults]
                    .reverse()
                    .find(item =>
                        item?.result
                    );

            const lastResult =
                lastCartResult?.result ||
                null;

            const cart =
                lastResult?.cart ||
                null;

            if (
                lastResult?.status ===
                    'cart_empty' ||
                cart?.status ===
                    'cart_not_found'
            ) {
                return {
                    status: 'ready',
                    responseText:
                        natural(
                            'cartEmptyText',
                            'cartEmpty'
                        )
                };
            }

            if (
                cart?.status === 'cart_ready' &&
                Array.isArray(cart.items)
            ) {
                if (cart.items.length === 0) {
                    return {
                        status: 'ready',
                        responseText:
                            natural(
                            'cartEmptyText',
                            'cartEmpty'
                        )
                    };
                }

                const lines =
                    cart.items.map(item => {
                        const name =
                            String(
                                item.product_name ||
                                'Produk'
                            ).trim();

                        const quantity =
                            Number(
                                item.quantity || 0
                            );

                        const subtotal =
                            Number(
                                item.subtotal || 0
                            );

                        return (
                            `• ${name} × ${quantity}` +
                            (
                                Number.isFinite(
                                    subtotal
                                )
                                    ? ` — ${this.rupiah(subtotal)}`
                                    : ''
                            )
                        );
                    });

                const total =
                    Number(
                        cart.totalAmount || 0
                    );

                /*
                 * Jika satu pesan melakukan beberapa mutasi cart,
                 * rangkum SEMUA hasil sukses authoritative.
                 *
                 * Nama produk dan quantity diambil hanya dari
                 * result backend. Tidak mengambil fakta dari AI.
                 */
                const mutationLines =
                    cartResults
                        .map(item => {
                            const result =
                                item?.result || null;

                            const name =
                                String(
                                    result?.productName ||
                                    ''
                                ).trim();

                            if (!name) {
                                return null;
                            }

                            if (
                                result.status ===
                                    'product_added_to_cart'
                            ) {
                                const qty =
                                    Number(
                                        result.quantity
                                    );

                                if (
                                    !Number.isInteger(qty) ||
                                    qty < 1
                                ) {
                                    return null;
                                }

                                if (language === 'su') {
                                    return `• ${name} × ${qty} parantos ditambihkeun`;
                                }

                                if (language === 'en') {
                                    return `• ${name} × ${qty} added`;
                                }

                                return `• ${name} × ${qty} ditambahkan`;
                            }

                            if (
                                result.status ===
                                    'cart_quantity_updated'
                            ) {
                                const qty =
                                    Number(
                                        result.quantity
                                    );

                                if (
                                    !Number.isInteger(qty) ||
                                    qty < 1
                                ) {
                                    return null;
                                }

                                if (language === 'su') {
                                    return `• ${name} jumlahna janten ${qty}`;
                                }

                                if (language === 'en') {
                                    return `• ${name} quantity is now ${qty}`;
                                }

                                return `• ${name} jumlahnya jadi ${qty}`;
                            }

                            if (
                                result.status ===
                                    'product_removed_from_cart'
                            ) {
                                if (language === 'su') {
                                    return `• ${name} parantos dipiceun`;
                                }

                                if (language === 'en') {
                                    return `• ${name} removed`;
                                }

                                return `• ${name} dihapus`;
                            }

                            return null;
                        })
                        .filter(Boolean);

                const multiMutationSummary =
                    mutationLines.length > 1
                        ? (
                            (
                                language === 'su'
                                    ? 'Siap, pamundut karanjang parantos diproses:'
                                    : language === 'en'
                                        ? 'Done, your cart updates have been processed:'
                                        : 'Siap, perubahan keranjang sudah diproses:'
                            ) +
                            '\n' +
                            mutationLines.join('\n')
                        )
                        : null;

                let intro =
                    natural(
                        'cartViewText',
                        'cartNow'
                    );

                const lastType =
                    lastCartResult
                        ?.operation
                        ?.type;

                if (
                    lastType ===
                        'ADD_PRODUCT'
                ) {
                    intro =
                        natural(
                            'cartAddedText',
                            'added'
                        );
                } else if (
                    lastType ===
                        'REMOVE_PRODUCT'
                ) {
                    const removedName =
                        String(
                            lastResult
                                ?.productName ||
                            ''
                        ).trim();

                    const naturalRemoved =
                        this.sanitizeNaturalStyle(
                            style.cartRemovedText
                        );

                    intro =
                        naturalRemoved ||
                        (
                            removedName
                                ? (
                                    language === 'su'
                                        ? `${removedName} parantos dipiceun tina karanjang.`
                                        : language === 'en'
                                            ? `${removedName} has been removed from your cart.`
                                            : `${removedName} sudah dihapus dari keranjang.`
                                )
                                : this.text(
                                    language,
                                    'removed'
                                )
                        );
                } else if (
                    lastType ===
                        'SET_QUANTITY'
                ) {
                    intro =
                        natural(
                            'cartQuantityUpdatedText',
                            'quantityUpdated'
                        );
                }

                let responseText =
                    multiMutationSummary
                        ? (
                            `${multiMutationSummary}\n\n` +
                            `${natural(
                                'cartViewText',
                                'cartNow'
                            )}\n` +
                            lines.join('\n') +
                            `\n\n${this.text(
                                language,
                                'total'
                            )}: ${this.rupiah(total)}`
                        )
                        : (
                            `${intro}\n\n` +
                            lines.join('\n') +
                            `\n\n${this.text(
                                language,
                                'total'
                            )}: ${this.rupiah(total)}`
                        );

                if (
                    execution.status ===
                        'executed_with_clarification'
                ) {
                    responseText +=
                        '\n\n' +
                        natural(
                            'cartClarificationText',
                            'clarification'
                        );
                }

                return {
                    status: 'ready',
                    responseText
                };
            }
        }

        /*
         * Multi-action fulfillment + payment.
         *
         * Kedua responseText berasal dari service
         * canonical. Builder hanya menggabungkan
         * fakta yang sudah divalidasi DB.
         */
        const fulfillmentResult =
            results.find(item =>
                [
                    'pickup_selected',
                    'delivery_selected'
                ].includes(
                    item?.result?.status
                ) &&
                typeof item.result.responseText ===
                    'string' &&
                item.result.responseText.trim()
            );

        const paymentResult =
            results.find(item =>
                [
                    'outlet_payment_selected',
                    'online_payment_selected'
                ].includes(
                    item?.result?.status
                ) &&
                typeof item.result.responseText ===
                    'string' &&
                item.result.responseText.trim()
            );

        if (
            fulfillmentResult &&
            paymentResult
        ) {
            const fulfillment =
                fulfillmentResult.result;
            const payment =
                paymentResult.result;

            if (
                fulfillment.status ===
                    'pickup_selected'
            ) {
                const location =
                    String(
                        fulfillment.draft
                            ?.pickup_location_snapshot ||
                        ''
                    ).trim();

                if (!location) {
                    return {
                        status:
                            'response_unavailable',
                        responseText: null
                    };
                }

                const paymentText =
                    payment.responseText
                        .trim();

                return {
                    status: 'ready',
                    responseText:
                        'Sip, kamu ambil sendiri di outlet ya.\n\n' +
                        `Lokasi:\n${location}\n\n` +
                        paymentText
                };
            }

            return {
                status: 'ready',
                responseText:
                    fulfillment.responseText.trim() +
                    '\n\n' +
                    payment.responseText.trim()
            };
        }

        /*
         * Ambil hasil terakhir yang benar-benar
         * mempunyai responseText canonical.
         *
         * Ini penting untuk multi-action:
         * PICKUP -> OUTLET
         * cukup memakai respons payment terakhir,
         * karena itu sudah menjadi next-step customer.
         */
        const canonical =
            [...results]
                .reverse()
                .map(item => item?.result)
                .find(result =>
                    typeof result?.responseText ===
                        'string' &&
                    result.responseText.trim()
                );

        if (canonical) {
            return {
                status: 'ready',
                responseText:
                    canonical.responseText.trim()
            };
        }

        /*
         * Product selection biasanya membawa draft
         * authoritative dari handler tetapi responseText
         * lama belum tentu tersedia.
         */
        const productSelection =
            results.find(item =>
                item?.result?.status ===
                    'product_selected' &&
                item.result.draft
            );

        if (productSelection) {
            const draft =
                productSelection.result.draft;

            const productName =
                String(
                    draft.productName || ''
                ).trim();

            const quantity =
                Number(draft.quantity);

            const subtotal =
                Number(draft.subtotal);

            if (
                productName &&
                Number.isInteger(quantity) &&
                quantity > 0 &&
                Number.isFinite(subtotal)
            ) {
                return {
                    status: 'ready',
                    responseText:
                        `Siap kak, ${productName} jadi ${quantity} ya.\n` +
                        `Total sementara: ${this.rupiah(subtotal)}`
                };
            }
        }

        /*
         * SET_QUANTITY pada service canonical normalnya
         * sudah mempunyai responseText.
         * Fallback ini hanya dipakai bila result minimal
         * masih membawa quantity authoritative.
         */
        const quantityResult =
            results.find(item =>
                item?.result?.status ===
                    'quantity_updated'
            );

        if (quantityResult) {
            const quantity =
                Number(
                    quantityResult.result.quantity ??
                    quantityResult.result
                        .draft?.quantity
                );

            if (
                Number.isInteger(quantity) &&
                quantity > 0
            ) {
                return {
                    status: 'ready',
                    responseText:
                        `Siap kak, jumlahnya jadi ${quantity} ya.`
                };
            }
        }

        return {
            status: 'response_unavailable',
            responseText: null
        };
    }

    rupiah(value) {
        return new Intl.NumberFormat(
            'id-ID',
            {
                style: 'currency',
                currency: 'IDR',
                maximumFractionDigits: 0
            }
        ).format(Number(value));
    }
}

module.exports =
    PasarPintarAIResponseBuilder;
