'use strict';

function normalizeAddress(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function isBandungCityAddress(address) {
    const normalized = normalizeAddress(address);

    if (!normalized) {
        return false;
    }

    /*
     * Pilot DELIVERY hanya Kota Bandung.
     * Tolak alamat yang jelas menyebut wilayah
     * Kabupaten Bandung atau Bandung Barat.
     */
    if (
        normalized.includes('kabupaten bandung') ||
        normalized.includes('kab. bandung') ||
        normalized.includes('kab bandung') ||
        normalized.includes('bandung barat')
    ) {
        return false;
    }

    return (
        normalized.includes('kota bandung') ||
        normalized.includes('bandung')
    );
}

function validatePilotDeliveryAddress(
    address,
    city = null
) {
    const normalized =
        normalizeAddress(address);

    if (!normalized) {
        return {
            ok: false,
            code: 'SHIPPING_ADDRESS_REQUIRED',
            message:
                'Alamat pengiriman wajib diisi untuk DELIVERY'
        };
    }

    const normalizedCity =
        normalizeAddress(city);

    /*
     * Structured city menjadi source-of-truth
     * bila tersedia.
     *
     * Alamat teks tetap menjadi fallback untuk
     * flow legacy dan WhatsApp.
     */
    const areaValue =
        normalizedCity || normalized;

    if (!isBandungCityAddress(areaValue)) {
        return {
            ok: false,
            code: 'DELIVERY_AREA_NOT_SUPPORTED',
            message:
                'Untuk saat ini pengiriman gratis hanya tersedia di Kota Bandung. Silakan gunakan alamat Kota Bandung atau pilih PICKUP.'
        };
    }

    return {
        ok: true,
        code: 'DELIVERY_AREA_OK',
        normalized_address:
            String(address || '').trim(),
        normalized_city:
            normalizedCity || null
    };
}

module.exports = {
    validatePilotDeliveryAddress,
    isBandungCityAddress
};
