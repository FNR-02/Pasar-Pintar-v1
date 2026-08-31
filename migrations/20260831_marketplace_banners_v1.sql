BEGIN;

CREATE TABLE IF NOT EXISTS tbl_marketplace_banners (
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    market_id UUID NULL
        REFERENCES tbl_markets(id)
        ON DELETE CASCADE,

    placement VARCHAR(20) NOT NULL,

    image_url TEXT NOT NULL,

    title VARCHAR(160) NULL,
    subtitle TEXT NULL,
    target_url TEXT NULL,

    sort_order INTEGER NOT NULL
        DEFAULT 0,

    starts_at TIMESTAMPTZ NULL,
    ends_at TIMESTAMPTZ NULL,

    status VARCHAR(20) NOT NULL
        DEFAULT 'DRAFT',

    created_by UUID NULL
        REFERENCES tbl_users(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT marketplace_banner_placement_check
        CHECK (
            placement IN (
                'HERO',
                'MIDDLE'
            )
        ),

    CONSTRAINT marketplace_banner_status_check
        CHECK (
            status IN (
                'DRAFT',
                'ACTIVE',
                'INACTIVE',
                'ARCHIVED'
            )
        ),

    CONSTRAINT marketplace_banner_sort_order_check
        CHECK (sort_order >= 0),

    CONSTRAINT marketplace_banner_schedule_check
        CHECK (
            ends_at IS NULL
            OR starts_at IS NULL
            OR ends_at > starts_at
        )
);

CREATE INDEX IF NOT EXISTS
    idx_marketplace_banners_public
ON tbl_marketplace_banners (
    market_id,
    placement,
    status,
    sort_order
);

CREATE INDEX IF NOT EXISTS
    idx_marketplace_banners_schedule
ON tbl_marketplace_banners (
    starts_at,
    ends_at
);

COMMIT;
