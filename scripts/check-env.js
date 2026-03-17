
require('dotenv').config({ path: '.env.local' });

console.log('Checking for DATABASE_URL...');
if (process.env.DATABASE_URL) {
    console.log('✅ DATABASE_URL is available!');
    // Don't print the actual value for security
} else {
    console.log('❌ DATABASE_URL is NOT available.');
}

if (process.env.POSTGRES_URL) {
    console.log('✅ POSTGRES_URL is available!');
}

if (process.env.SUPABASE_DB_URL) {
    console.log('✅ SUPABASE_DB_URL is available!');
}
