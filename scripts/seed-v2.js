
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const ROOT_DIR = path.resolve('..', 'Policies and Commission Files');

// Helper to parse agency folder names
function parseAgencyName(folderName) {
    const match = folderName.match(/^(.+?)\[(.+?)\]$/);
    if (match) {
        return match[1].trim(); // Return just the name without [agency1]
    }
    return folderName;
}

async function clearExistingData() {
    console.log('🧹 Clearing existing data...');

    await supabase.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('agents').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('agency_carriers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('carriers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('agencies').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    console.log('✓ Cleared existing data\n');
}

async function scanDirectoryStructure() {
    console.log('📂 Scanning directory structure...');

    if (!fs.existsSync(ROOT_DIR)) {
        console.error('Root directory not found!');
        process.exit(1);
    }

    const structure = {
        agencies: [],
        carriersByAgency: {}
    };

    const agencyFolders = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory());

    for (const agencyFolder of agencyFolders) {
        const agencyName = parseAgencyName(agencyFolder.name);
        structure.agencies.push(agencyName);
        structure.carriersByAgency[agencyName] = [];

        const agencyPath = path.join(ROOT_DIR, agencyFolder.name);
        const carrierFolders = fs.readdirSync(agencyPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());

        for (const carrierFolder of carrierFolders) {
            structure.carriersByAgency[agencyName].push(carrierFolder.name);
        }
    }

    console.log(`✓ Found ${structure.agencies.length} agencies`);
    console.log(`✓ Scanned carriers from filesystem\n`);

    return structure;
}

async function seedAgencies(agencyNames) {
    console.log('📋 Seeding agencies...');
    const agencyMap = {};

    for (const agencyName of agencyNames) {
        const { data, error } = await supabase
            .from('agencies')
            .insert([{ name: agencyName }])
            .select()
            .single();

        if (error) {
            console.error(`Error creating agency ${agencyName}:`, error);
        } else {
            agencyMap[agencyName] = data;
            console.log(`✓ Created: ${agencyName}`);
        }
    }

    return agencyMap;
}

async function getUniqueCarriers(carriersByAgency) {
    // Get unique carrier names across all agencies
    const allCarriers = new Set();
    for (const carriers of Object.values(carriersByAgency)) {
        carriers.forEach(carrier => allCarriers.add(carrier));
    }
    return Array.from(allCarriers);
}

async function seedCarriers(uniqueCarriers) {
    console.log('\n🏢 Seeding carriers (unique entries)...');
    const carrierMap = {};

    for (const carrierName of uniqueCarriers) {
        const { data, error } = await supabase
            .from('carriers')
            .insert([{ name: carrierName }])
            .select()
            .single();

        if (error) {
            console.error(`Error creating carrier ${carrierName}:`, error);
        } else {
            carrierMap[carrierName] = data;
            console.log(`✓ Created: ${carrierName}`);
        }
    }

    return carrierMap;
}

async function linkCarriersToAgencies(agencyMap, carrierMap, carriersByAgency) {
    console.log('\n🔗 Linking carriers to agencies...');
    const junctionMap = {};

    // For each unique carrier, link it to the agencies where it appears
    for (const [carrierName, carrierData] of Object.entries(carrierMap)) {
        junctionMap[carrierName] = [];

        // Find which agencies have this carrier
        for (const [agencyName, carriers] of Object.entries(carriersByAgency)) {
            if (carriers.includes(carrierName)) {
                const { data, error } = await supabase
                    .from('agency_carriers')
                    .insert([{
                        agency_id: agencyMap[agencyName].id,
                        carrier_id: carrierData.id
                    }])
                    .select()
                    .single();

                if (!error) {
                    junctionMap[carrierName].push({
                        ...data,
                        agency_name: agencyName,
                        carrier_name: carrierName
                    });
                    console.log(`✓ ${carrierName} → ${agencyName}`);
                }
            }
        }
    }

    return junctionMap;
}

async function indexExistingFiles(junctionMap, carriersByAgency) {
    console.log('\n📄 Indexing existing files...');
    let fileCount = 0;

    for (const agencyName of Object.keys(carriersByAgency)) {
        const agencyFolderName = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && parseAgencyName(d.name) === agencyName)
            .map(d => d.name)[0];

        if (!agencyFolderName) continue;

        const agencyPath = path.join(ROOT_DIR, agencyFolderName);

        for (const carrierName of carriersByAgency[agencyName]) {
            const carrierPath = path.join(agencyPath, carrierName);

            // Find the junction record for this agency-carrier pair
            const junction = junctionMap[carrierName]?.find(j => j.agency_name === agencyName);
            if (!junction) continue;

            // Look for Policy and Commission folders
            const subDirs = fs.readdirSync(carrierPath, { withFileTypes: true })
                .filter(d => d.isDirectory());

            for (const subDir of subDirs) {
                let fileType = null;
                const dirName = subDir.name.toLowerCase();

                if (dirName.includes('policy') || dirName.includes('policies')) {
                    fileType = 'Policy';
                } else if (dirName.includes('commission') || dirName.includes('commision')) {
                    fileType = 'Commission';
                }

                if (fileType) {
                    const subDirPath = path.join(carrierPath, subDir.name);
                    const files = fs.readdirSync(subDirPath)
                        .filter(f => !fs.lstatSync(path.join(subDirPath, f)).isDirectory());

                    for (const file of files) {
                        const { error } = await supabase
                            .from('files')
                            .insert([{
                                agency_carrier_id: junction.id,
                                type: fileType,
                                filename: file,
                                is_local: true
                            }]);

                        if (!error) {
                            fileCount++;
                        }
                    }
                }
            }
        }
    }

    console.log(`✓ Indexed ${fileCount} existing files`);
}

async function seedSampleAgents(agencyMap) {
    console.log('\n� Seeding sample agents...');
    const agentNames = ['John Smith', 'Sarah Johnson', 'Michael Chen', 'Emily Davis'];
    const agencyNames = Object.keys(agencyMap);

    for (let i = 0; i < agentNames.length; i++) {
        const agencyName = agencyNames[i % agencyNames.length];
        const agentName = agentNames[i];
        const email = agentName.toLowerCase().replace(' ', '.') + '@example.com';

        const { error } = await supabase
            .from('agents')
            .insert([{
                name: agentName,
                email: email,
                agency_id: agencyMap[agencyName].id
            }]);

        if (!error) {
            console.log(`✓ ${agentName} → ${agencyName}`);
        }
    }
}

async function printSummary(agencyMap, carrierMap, junctionMap) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 SEED SUMMARY');
    console.log('='.repeat(60));
    console.log(`✓ Agencies: ${Object.keys(agencyMap).length}`);
    console.log(`✓ Unique Carriers: ${Object.keys(carrierMap).length}`);
    console.log(`✓ Agency-Carrier Links: ${Object.values(junctionMap).flat().length}`);

    console.log('\n📋 Carrier Distribution:');
    for (const [carrierName, junctions] of Object.entries(junctionMap)) {
        const agencies = junctions.map(j => j.agency_name).join(' + ');
        const badge = junctions.length > 1 ? '🔗' : '  ';
        console.log(`   ${badge} ${carrierName}: ${agencies}`);
    }
    console.log('='.repeat(60) + '\n');
}

async function seed() {
    console.log('🚀 Starting V2 seed process (from directory)...\n');

    try {
        const structure = await scanDirectoryStructure();
        await clearExistingData();

        const agencyMap = await seedAgencies(structure.agencies);
        const uniqueCarriers = await getUniqueCarriers(structure.carriersByAgency);
        const carrierMap = await seedCarriers(uniqueCarriers);
        const junctionMap = await linkCarriersToAgencies(agencyMap, carrierMap, structure.carriersByAgency);

        await indexExistingFiles(junctionMap, structure.carriersByAgency);
        await seedSampleAgents(agencyMap);
        await printSummary(agencyMap, carrierMap, junctionMap);

        console.log('✅ Seeding completed successfully!\n');
    } catch (error) {
        console.error('\n❌ Seeding failed:', error);
    }
}

seed();
