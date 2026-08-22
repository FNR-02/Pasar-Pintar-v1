class WhatsAppIntentRouter {
    route({ intent, text, customer }) {
        const normalizedIntent =
            String(intent || 'UNKNOWN')
                .trim()
                .toUpperCase();

        const context = {
            text: String(text || '').trim(),
            customer: customer || null
        };

        switch (normalizedIntent) {
            case 'GREETING':
                return {
                    handler: 'GREETING_HANDLER',
                    action: 'RESPOND_ONLY',
                    context
                };

            case 'PRODUCT_INQUIRY':
                return {
                    handler: 'PRODUCT_INQUIRY_HANDLER',
                    action: 'READ_CATALOG',
                    context
                };

            case 'PRODUCT_ORDER':
                return {
                    handler: 'PRODUCT_ORDER_DRAFT_HANDLER',
                    action: 'CREATE_DRAFT_ONLY',
                    context
                };

            case 'ORDER_STATUS':
                return {
                    handler: 'ORDER_STATUS_HANDLER',
                    action: 'READ_CUSTOMER_ORDERS',
                    context
                };

            case 'ADDRESS_UPDATE':
                return {
                    handler: 'ADDRESS_UPDATE_HANDLER',
                    action: 'REQUIRE_CONFIRMATION',
                    context
                };

            case 'EMPTY_MESSAGE':
                return {
                    handler: 'EMPTY_MESSAGE_HANDLER',
                    action: 'RESPOND_ONLY',
                    context
                };

            default:
                return {
                    handler: 'FALLBACK_HANDLER',
                    action: 'RESPOND_ONLY',
                    context
                };
        }
    }
}

module.exports = WhatsAppIntentRouter;
