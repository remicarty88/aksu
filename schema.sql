CREATE TABLE IF NOT EXISTS car_models (
  id serial PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS categories (
  id serial PRIMARY KEY,
  name_ru text NOT NULL,
  name_uz text NOT NULL DEFAULT '',
  slug text UNIQUE NOT NULL,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  code text NOT NULL DEFAULT '',
  category_id int REFERENCES categories(id) ON DELETE SET NULL,
  name_ru text NOT NULL,
  name_uz text NOT NULL DEFAULT '',
  desc_ru text NOT NULL DEFAULT '',
  desc_uz text NOT NULL DEFAULT '',
  price int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_fits (
  product_id int REFERENCES products(id) ON DELETE CASCADE,
  model_id int REFERENCES car_models(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, model_id)
);
CREATE TABLE IF NOT EXISTS admins (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id serial PRIMARY KEY,
  mime text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_images (
  product_id int REFERENCES products(id) ON DELETE CASCADE,
  image_id int REFERENCES images(id) ON DELETE CASCADE,
  sort int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, image_id)
);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_id int REFERENCES images(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS site_texts (
  key text PRIMARY KEY,
  ru text NOT NULL DEFAULT '',
  uz text NOT NULL DEFAULT ''
);
ALTER TABLE car_models ADD COLUMN IF NOT EXISTS image_id int REFERENCES images(id) ON DELETE SET NULL;
