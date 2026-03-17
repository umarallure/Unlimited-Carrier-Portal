
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Define our agencies
const AGENCIES = [
    { name: 'Unlimited Insurance' },
    { name: 'Heritage Insurance' }
];

// Define unique carriers (these will be shared across agencies)
const CARRIERS = [
    'AETNA',
    'AMAM',
    'Americo',
    'CHUBB',
    'CICA',
    'CoreBridge',
    'Liberty',
    'MOH',
    'RNA',
    'SBLI',
    'Transamerica',
    'Humana',
    'UnitedHealthcare',
    'Cigna',
    'MetLife'
];

// Define some sample agents
const AGENT_NAMES = [
    'John Smith',
    'Sarah Johnson',
    'Michael Chen',
    'Emily Davis',
    'Robert Williams',
    'Jessica Martinez',
    'David Brown',
    'Amanda Garcia'
];

async function clearExistingData() {
    console.log('Clearing existing data...');

    // Delete in order due to foreign key constraints
    await supabase.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('agents').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('carriers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('agencies').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    console.log('✓ Cleared existing data');
}

async function seedAgencies() {
    console.log('\nSeeding agencies...');
    const agencyIds = {};

    for (const agency of AGENCIES) {
        const { data, error } = await supabase
            .from('agencies')
            .insert([agency])
            .select()
            .single();

        if (error) {
            console.error(`Error creating agency ${agency.name}:`, error);
        } else {
            agencyIds[agency.name] = data.id;
            console.log(`✓ Created agency: ${agency.name}`);
        }
    }

    return agencyIds;
}

async function seedCarriers(agencyIds) {
    console.log('\nSeeding carriers...');
    const carrierIds = {};
    const agencyNames = Object.keys(agencyIds);

    // Create each carrier and randomly assign to 1-2 agencies
    for (const carrierName of CARRIERS) {
        carrierIds[carrierName] = [];

        // Randomly decide how many agencies get this carrier (1 or 2)
        const numAgencies = Math.random() > 0.5 ? 2 : 1;

        // Shuffle and pick agencies
        const shuffled = [...agencyNames].sort(() => Math.random() - 0.5);
        const selectedAgencies = shuffled.slice(0, numAgencies);

        for (const agencyName of selectedAgencies) {
            const { data, error } = await supabase
                .from('carriers')
                .insert([{
                    name: carrierName,
                    agency_id: agencyIds[agencyName]
                }])
                .select()
                .single();

            if (error) {
                console.error(`Error creating carrier ${carrierName} for ${agencyName}:`, error);
            } else {
                carrierIds[carrierName].push({
                    id: data.id,
                    agency_id: agencyIds[agencyName],
                    agency_name: agencyName
                });
                console.log(`✓ Assigned ${carrierName} to ${agencyName}`);
            }
        }
    }

    return carrierIds;
}

async function seedAgents(agencyIds) {
    console.log('\nSeeding agents...');
    const agencyNames = Object.keys(agencyIds);

    // Distribute agents across agencies
    for (let i = 0; i < AGENT_NAMES.length; i++) {
        const agencyName = agencyNames[i % agencyNames.length];
        const agentName = AGENT_NAMES[i];
        const email = agentName.toLowerCase().replace(' ', '.') + '@example.com';

        const { error } = await supabase
            .from('agents')
            .insert([{
                name: agentName,
                email: email,
                agency_id: agencyIds[agencyName]
            }]);

        if (error) {
            console.error(`Error creating agent ${agentName}:`, error);
        } else {
            console.log(`✓ Created agent: ${agentName} at ${agencyName}`);
        }
    }
}

async function seedSampleFiles(carrierIds) {
    console.log('\nSeeding sample files...');
    const fileTypes = ['Policy', 'Commission'];
    let fileCount = 0;

    // Create 2-3 sample files for each carrier instance
    for (const [carrierName, instances] of Object.entries(carrierIds)) {
        for (const instance of instances) {
            const numFiles = Math.floor(Math.random() * 2) + 2; // 2-3 files

            for (let i = 0; i < numFiles; i++) {
                const fileType = fileTypes[Math.floor(Math.random() * fileTypes.length)];
                const filename = `${carrierName}_${fileType}_Sample_${i + 1}.xlsx`;

                const { error } = await supabase
                    .from('files')
                    .insert([{
                        agency_id: instance.agency_id,
                        carrier_id: instance.id,
                        type: fileType,
                        filename: filename,
                        is_local: false
                    }]);

                if (!error) {
                    fileCount++;
                }
            }
        }
    }

    console.log(`✓ Created ${fileCount} sample files`);
}

async function seed() {
    console.log('🚀 Starting smart seed process...\n');

    try {
        await clearExistingData();
        const agencyIds = await seedAgencies();
        const carrierIds = await seedCarriers(agencyIds);
        await seedAgents(agencyIds);
        await seedSampleFiles(carrierIds);

        console.log('\n✅ Seeding completed successfully!');
        console.log('\nSummary:');
        console.log(`- Agencies: ${AGENCIES.length}`);
        console.log(`- Unique Carriers: ${CARRIERS.length}`);
        console.log(`- Agents: ${AGENT_NAMES.length}`);
        console.log(`- Files: Sample files generated`);
    } catch (error) {
        console.error('\n❌ Seeding failed:', error);
    }
}

seed();
