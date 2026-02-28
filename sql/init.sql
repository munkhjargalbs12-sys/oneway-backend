-- Minimal schema for OneWay app (for local testing)

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'passenger',
  avatar_id VARCHAR(100),
  rating NUMERIC(2,1) DEFAULT 0,
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- Rides
CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  vehicle_id INT REFERENCES vehicles(id) ON DELETE SET NULL,
  start_lat NUMERIC(9,6),
  start_lng NUMERIC(9,6),
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
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
