-- Schema for OneWay app

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'passenger',
  avatar_id VARCHAR(100) DEFAULT 'guy',
  rating NUMERIC(2,1) DEFAULT 1,
  email TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  identity_verified BOOLEAN DEFAULT FALSE,
  driver_license_verified BOOLEAN DEFAULT FALSE,
  verification_status VARCHAR(20) DEFAULT 'none',
  verification_submitted_at TIMESTAMP,
  verification_approved_at TIMESTAMP,
  verification_rejected_at TIMESTAMP,
  verification_note TEXT,
  payment_linked BOOLEAN DEFAULT FALSE,
  payment_account TEXT,
  driver_verified BOOLEAN DEFAULT FALSE,
  driver_license_number TEXT,
  one_way_verified BOOLEAN DEFAULT FALSE,
  expo_push_token TEXT,
  expo_push_token_updated_at TIMESTAMP,
  balance INT DEFAULT 0,
  locked_balance INT DEFAULT 0,
  total_rides INT DEFAULT 0,
  is_blocked BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Vehicles
CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT,
  model TEXT,
  color TEXT,
  plate_number TEXT,
  seats INT DEFAULT 4,
  vehicle_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Rides
CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  vehicle_id INT REFERENCES vehicles(id) ON DELETE SET NULL,
  start_lat NUMERIC(9,6),
  start_lng NUMERIC(9,6),
  start_location TEXT,
  end_lat NUMERIC(9,6),
  end_lng NUMERIC(9,6),
  end_location TEXT,
  polyline TEXT,
  price INT,
  seats_total INT,
  seats_taken INT DEFAULT 0,
  ride_date DATE,
  start_time TIME,
  days TEXT[],
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bookings
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  ride_id INT REFERENCES rides(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  seats_booked INT DEFAULT 1,
  status VARCHAR(20) DEFAULT 'pending',
  approved_by INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Ratings
CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  ride_id INT REFERENCES rides(id) ON DELETE SET NULL,
  from_user INT REFERENCES users(id) ON DELETE SET NULL,
  to_user INT REFERENCES users(id) ON DELETE SET NULL,
  rating INT NOT NULL,
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT,
  type VARCHAR(50),
  related_id INT,
  from_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  from_user_name TEXT,
  from_avatar_id VARCHAR(100),
  ride_id INT REFERENCES rides(id) ON DELETE SET NULL,
  booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ride_presence (
  id SERIAL PRIMARY KEY,
  ride_id INT REFERENCES rides(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  role VARCHAR(20) NOT NULL,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  accuracy_meters NUMERIC(8,2),
  distance_to_start_meters NUMERIC(8,2),
  distance_to_driver_meters NUMERIC(8,2),
  within_start_radius BOOLEAN DEFAULT FALSE,
  within_driver_radius BOOLEAN DEFAULT FALSE,
  source VARCHAR(30) DEFAULT 'none',
  dwell_started_at TIMESTAMP,
  arrived_at TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT ride_presence_unique_ride_user UNIQUE (ride_id, user_id)
);

-- Wallet transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  amount INT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'super_admin',
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_user_id INT REFERENCES admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INT,
  meta JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Backfill / compatibility for existing DBs
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_license_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_submitted_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_approved_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_rejected_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_linked BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_account TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_license_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS one_way_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expo_push_token_updated_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_balance INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_rides INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
ALTER TABLE users ALTER COLUMN avatar_id SET DEFAULT 'guy';

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS seats_booked INT DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attendance_status VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attendance_marked_at TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attendance_marked_by INT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS start_location TEXT;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS from_user_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS from_user_name TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS from_avatar_id VARCHAR(100);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ride_id INT REFERENCES rides(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id) ON DELETE SET NULL;

ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS role VARCHAR(20);
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6);
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS accuracy_meters NUMERIC(8,2);
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS distance_to_start_meters NUMERIC(8,2);
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS distance_to_driver_meters NUMERIC(8,2);
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS within_start_radius BOOLEAN DEFAULT FALSE;
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS within_driver_radius BOOLEAN DEFAULT FALSE;
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'none';
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS dwell_started_at TIMESTAMP;
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP;
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'ride_presence_unique_ride_user'
  ) THEN
    ALTER TABLE ride_presence
      ADD CONSTRAINT ride_presence_unique_ride_user UNIQUE (ride_id, user_id);
  END IF;
END $$;

ALTER TABLE email_verification_codes ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP;

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'super_admin';
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_user_id
  ON email_verification_codes(user_id);

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_expires_at
  ON email_verification_codes(expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_user_id
  ON admin_audit_logs(admin_user_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at
  ON admin_audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_ride_presence_ride_id
  ON ride_presence(ride_id);

CREATE INDEX IF NOT EXISTS idx_ride_presence_user_id
  ON ride_presence(user_id);

CREATE INDEX IF NOT EXISTS idx_ride_presence_arrived_at
  ON ride_presence(arrived_at);

UPDATE users
SET rating = 1
WHERE rating IS NULL OR rating < 1;

UPDATE users
SET avatar_id = 'guy'
WHERE avatar_id IS NULL OR btrim(avatar_id) = '';

UPDATE users
SET
  email_verified = COALESCE(email_verified, FALSE),
  phone_verified = COALESCE(phone_verified, FALSE),
  identity_verified = COALESCE(identity_verified, FALSE),
  driver_license_verified = COALESCE(driver_license_verified, FALSE),
  payment_linked = COALESCE(payment_linked, FALSE),
  driver_verified = COALESCE(driver_verified, FALSE),
  one_way_verified = COALESCE(one_way_verified, FALSE),
  balance = COALESCE(balance, 0),
  locked_balance = COALESCE(locked_balance, 0),
  total_rides = COALESCE(total_rides, 0),
  verification_status = COALESCE(verification_status, 'none');

UPDATE bookings
SET attendance_status = 'unknown'
WHERE attendance_status IS NULL OR btrim(attendance_status) = '';
