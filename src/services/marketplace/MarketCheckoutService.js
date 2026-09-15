const OrderInventoryReservationService =
    require('../orders/OrderInventoryReservationService');
const PromotionPriceService =
    require('./PromotionPriceService');

const { validatePilotDeliveryAddress } =
    require('../delivery/DeliveryAreaPolicy');

class MarketCheckoutService {
    constructor(db) {
        this.db = db;
    }

    async create({
        userId,
        items,
        shippingAddress,
        shippingAddressLine = null,
        shippingVillage = null,
        shippingDistrict = null,
        shippingCity = null,
        shippingProvince = null,
        shippingPostalCode = null,
        shippingLandmark = null,
        shippingPlaceId = null,
        shippingLatitude = null,
        shippingLongitude = null,
        marketCode = 'PASAR-SEDERHANA'
    }) {
        if (!userId) {
            throw new Error('userId wajib');
        }

        if (!Array.isArray(items) || items.length === 0) {
            throw new Error('items wajib diisi');
        }

        const address =
            String(shippingAddress || '').trim();

        const structuredAddress = {
            addressLine:
                String(shippingAddressLine || '').trim() || null,
            village:
                String(shippingVillage || '').trim() || null,
            district:
                String(shippingDistrict || '').trim() || null,
            city:
                String(shippingCity || '').trim() || null,
            province:
                String(shippingProvince || '').trim() || null,
            postalCode:
                String(shippingPostalCode || '').trim() || null,
            landmark:
                String(shippingLandmark || '').trim() || null,
            placeId:
                String(shippingPlaceId || '').trim() || null,
            latitude: null,
            longitude: null
        };

        const hasLatitude =
            shippingLatitude !== undefined &&
            shippingLatitude !== null &&
            String(shippingLatitude).trim() !== '';

        const hasLongitude =
            shippingLongitude !== undefined &&
            shippingLongitude !== null &&
            String(shippingLongitude).trim() !== '';

        if (hasLatitude !== hasLongitude) {
            const error =
                new Error(
                    'Latitude dan longitude alamat harus diisi bersamaan'
                );
            error.code =
                'SHIPPING_COORDINATES_INCOMPLETE';
            throw error;
        }

        if (hasLatitude && hasLongitude) {
            structuredAddress.latitude =
                Number(shippingLatitude);
            structuredAddress.longitude =
                Number(shippingLongitude);

            if (
                !Number.isFinite(structuredAddress.latitude) ||
                !Number.isFinite(structuredAddress.longitude) ||
                structuredAddress.latitude < -90 ||
                structuredAddress.latitude > 90 ||
                structuredAddress.longitude < -180 ||
                structuredAddress.longitude > 180
            ) {
                const error =
                    new Error(
                        'Koordinat alamat pengiriman tidak valid'
                    );
                error.code =
                    'INVALID_SHIPPING_COORDINATES';
                throw error;
            }
        }

        const deliveryArea =
            validatePilotDeliveryAddress(
                address,
                structuredAddress.city
            );

        if (!deliveryArea.ok) {
            const error =
                new Error(deliveryArea.message);

            error.code =
                deliveryArea.code;

            throw error;
        }

        const customerResult =
            await this.db.query(
                `
                SELECT
                    id,
                    default_address,
                    default_address_line,
                    default_village,
                    default_district,
                    default_city,
                    default_province,
                    default_postal_code,
                    default_landmark,
                    default_place_id,
                    default_latitude,
                    default_longitude
                FROM tbl_customers
                WHERE user_id = $1
                LIMIT 1
                `,
                [userId]
            );

        if (!customerResult.rowCount) {
            throw new Error(
                'Customer tidak ditemukan'
            );
        }

        const customer =
            customerResult.rows[0];

        const customerId =
            customer.id;

        const usesDefaultAddress =
            String(
                customer.default_address || ''
            ).trim() === address;

        const marketResult =
            await this.db.query(
                `
                SELECT id, name, code
                FROM tbl_markets
                WHERE code = $1
                  AND status = 'ACTIVE'
                LIMIT 1
                `,
                [marketCode]
            );

        if (!marketResult.rowCount) {
            throw new Error(
                'Market aktif tidak ditemukan'
            );
        }

        const market =
            marketResult.rows[0];

        const validatedItems = [];

        for (const rawItem of items) {
            const quantity =
                Number(rawItem.quantity || 1);

            if (!rawItem.product_id) {
                throw new Error(
                    'product_id wajib diisi'
                );
            }

            if (
                !Number.isInteger(quantity) ||
                quantity <= 0
            ) {
                throw new Error(
                    `Quantity tidak valid untuk ${rawItem.product_id}`
                );
            }

            const productResult =
                await this.db.query(
                    `
                    SELECT
                        p.id,
                        p.merchant_id,
                        p.sku,
                        p.name,
                        p.selling_unit,
                        p.pack_size_value,
                        p.pack_size_unit,
                        m.store_name,
                        mm.stall_name
                    FROM tbl_products p
                    JOIN tbl_merchants m
                      ON m.id = p.merchant_id
                     AND m.status = 'ACTIVE'
                    JOIN tbl_market_merchants mm
                      ON mm.merchant_id = m.id
                     AND mm.market_id = $2
                     AND mm.status = 'ACTIVE'
                    WHERE p.id = $1
                      AND p.status = 'ACTIVE'
                      AND p.customer_visible = TRUE
                    LIMIT 1
                    `,
                    [
                        rawItem.product_id,
                        market.id
                    ]
                );

            if (!productResult.rowCount) {
                throw new Error(
                    `Produk ${rawItem.product_id} tidak tersedia di market`
                );
            }

            const product =
                productResult.rows[0];

            const effectivePrice =
                await PromotionPriceService
                    .getEffectivePrice(
                        this.db,
                        product.id
                    );

            if (
                !effectivePrice ||
                !Number.isFinite(
                    Number(effectivePrice.price)
                ) ||
                Number(effectivePrice.price) <= 0
            ) {
                throw new Error(
                    `Harga RETAIL belum tersedia untuk ${product.id}`
                );
            }

            const unitPrice =
                Number(effectivePrice.price);

            validatedItems.push({
                product_id:
                    product.id,
                merchant_id:
                    product.merchant_id,
                store_name:
                    product.store_name,
                stall_name:
                    product.stall_name,
                quantity,
                unit_price:
                    unitPrice,
                subtotal:
                    unitPrice * quantity,
                selling_unit:
                    String(
                        product.selling_unit || 'PCS'
                    ).toUpperCase(),
                pack_size_value:
                    product.pack_size_value === null
                        ? null
                        : Number(
                            product.pack_size_value
                        ),
                pack_size_unit:
                    product.pack_size_unit
                        ? String(
                            product.pack_size_unit
                        ).toUpperCase()
                        : null
            });
        }

        const totalAmount =
            validatedItems.reduce(
                (sum, item) =>
                    sum + item.subtotal,
                0
            );

        const marketOrderResult =
            await this.db.query(
                `
                INSERT INTO tbl_market_orders (
                    customer_id,
                    market_id,
                    status,
                    fulfillment_type,
                    shipping_address,
                    shipping_address_line,
                    shipping_village,
                    shipping_district,
                    shipping_city,
                    shipping_province,
                    shipping_postal_code,
                    shipping_landmark,
                    shipping_place_id,
                    shipping_latitude,
                    shipping_longitude,
                    total_amount
                )
                VALUES (
                    $1,
                    $2,
                    'PENDING',
                    'DELIVERY',
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    $12,
                    $13,
                    $14
                )
                RETURNING *
                `,
                [
                    customerId,
                    market.id,
                    address,
                    structuredAddress.addressLine ??
                        (
                            usesDefaultAddress
                                ? customer.default_address_line
                                : null
                        ),
                    structuredAddress.village ??
                        (
                            usesDefaultAddress
                                ? customer.default_village
                                : null
                        ),
                    structuredAddress.district ??
                        (
                            usesDefaultAddress
                                ? customer.default_district
                                : null
                        ),
                    structuredAddress.city ??
                        (
                            usesDefaultAddress
                                ? customer.default_city
                                : null
                        ),
                    structuredAddress.province ??
                        (
                            usesDefaultAddress
                                ? customer.default_province
                                : null
                        ),
                    structuredAddress.postalCode ??
                        (
                            usesDefaultAddress
                                ? customer.default_postal_code
                                : null
                        ),
                    structuredAddress.landmark ??
                        (
                            usesDefaultAddress
                                ? customer.default_landmark
                                : null
                        ),
                    structuredAddress.placeId ??
                        (
                            usesDefaultAddress
                                ? customer.default_place_id
                                : null
                        ),
                    structuredAddress.latitude ??
                        (
                            usesDefaultAddress
                                ? customer.default_latitude
                                : null
                        ),
                    structuredAddress.longitude ??
                        (
                            usesDefaultAddress
                                ? customer.default_longitude
                                : null
                        ),
                    totalAmount
                ]
            );

        const marketOrder =
            marketOrderResult.rows[0];

        const groups =
            new Map();

        for (const item of validatedItems) {
            const key =
                String(item.merchant_id);

            if (!groups.has(key)) {
                groups.set(key, []);
            }

            groups.get(key).push(item);
        }

        const childOrders = [];

        for (const [
            merchantId,
            merchantItems
        ] of groups.entries()) {
            const childTotal =
                merchantItems.reduce(
                    (sum, item) =>
                        sum + item.subtotal,
                    0
                );

            const childResult =
                await this.db.query(
                    `
                    INSERT INTO tbl_orders_v2 (
                        customer_id,
                        merchant_id,
                        status,
                        shipping_address,
                        total_amount,
                        fulfillment_type,
                        payment_mode,
                        market_order_id
                    )
                    VALUES (
                        $1,
                        $2,
                        'PENDING',
                        $3,
                        $4,
                        'DELIVERY',
                        'DIRECT',
                        $5
                    )
                    RETURNING *
                    `,
                    [
                        customerId,
                        merchantId,
                        address,
                        childTotal,
                        marketOrder.id
                    ]
                );

            const child =
                childResult.rows[0];

            for (const item of merchantItems) {
                await this.db.query(
                    `
                    INSERT INTO tbl_order_items (
                        order_id,
                        product_id,
                        quantity,
                        unit_price,
                        selling_unit_snapshot,
                        pack_size_value_snapshot,
                        pack_size_unit_snapshot
                    )
                    VALUES (
                        $1,$2,$3,$4,$5,$6,$7
                    )
                    `,
                    [
                        child.id,
                        item.product_id,
                        item.quantity,
                        item.unit_price,
                        item.selling_unit,
                        item.pack_size_value,
                        item.pack_size_unit
                    ]
                );
            }

            const expiresAt =
                new Date(
                    Date.now() +
                    30 * 60 * 1000
                );

            const reservationService =
                new OrderInventoryReservationService(
                    this.db
                );

            const reservation =
                await reservationService
                    .reserveOrder({
                        orderId:
                            child.id,
                        expiresAt
                    });

            childOrders.push({
                ...child,
                store_name:
                    merchantItems[0]
                        .store_name,
                items:
                    merchantItems,
                reservation
            });
        }

        const collectorTaskResult =
            await this.db.query(
                `
                INSERT INTO tbl_collector_tasks (
                    market_order_id,
                    status
                )
                VALUES ($1, 'PENDING')
                RETURNING *
                `,
                [marketOrder.id]
            );

        const collectorTask =
            collectorTaskResult.rows[0];

        let sequence = 1;
        const stops = [];

        for (const child of childOrders) {
            const stopResult =
                await this.db.query(
                    `
                    INSERT INTO tbl_collector_task_stops (
                        collector_task_id,
                        order_id,
                        sequence_no,
                        status
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        'PENDING'
                    )
                    RETURNING *
                    `,
                    [
                        collectorTask.id,
                        child.id,
                        sequence
                    ]
                );

            stops.push(
                stopResult.rows[0]
            );

            sequence += 1;
        }

        return {
            market,
            market_order:
                marketOrder,
            child_orders:
                childOrders,
            collector_task:
                collectorTask,
            collector_stops:
                stops
        };
    }
}

module.exports =
    MarketCheckoutService;
