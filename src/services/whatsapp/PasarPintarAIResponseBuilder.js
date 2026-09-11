class PasarPintarAIResponseBuilder {
    build(execution) {
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
                        'Keranjang belanja masih kosong ya.'
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
                            'Keranjang belanja masih kosong ya.'
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

                let intro =
                    'Keranjang kamu sekarang:';

                const lastType =
                    lastCartResult
                        ?.operation
                        ?.type;

                if (
                    lastType ===
                        'ADD_PRODUCT'
                ) {
                    intro =
                        'Siap, produknya sudah masuk keranjang.';
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

                    intro =
                        removedName
                            ? `${removedName} sudah dihapus dari keranjang.`
                            : 'Produknya sudah dihapus dari keranjang.';
                } else if (
                    lastType ===
                        'SET_QUANTITY'
                ) {
                    intro =
                        'Siap, jumlah produknya sudah diperbarui.';
                }

                let responseText =
                    `${intro}\n\n` +
                    lines.join('\n') +
                    `\n\nTotal: ${this.rupiah(total)}`;

                if (
                    execution.status ===
                        'executed_with_clarification'
                ) {
                    responseText +=
                        '\n\nAda produk yang masih perlu diperjelas sebelum bisa dimasukkan.';
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
