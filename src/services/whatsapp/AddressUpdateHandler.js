class AddressUpdateHandler {
    handle() {
        return {
            status: 'address_not_supported',
            responseText:
                'Perubahan alamat lewat WhatsApp belum tersedia.\n\n' +
                'Silakan gunakan alamat yang sudah terdaftar atau hubungi admin Pasar Pintar.'
        };
    }
}

module.exports = AddressUpdateHandler;
