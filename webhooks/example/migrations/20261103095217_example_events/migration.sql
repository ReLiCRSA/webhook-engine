BEGIN;
CREATE TABLE example_events (
  id         BIGSERIAL PRIMARY KEY,
  payload    JSONB     NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
COMMIT;
