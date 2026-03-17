
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

async function seed() {
    console.log(`Scanning directory: ${ROOT_DIR}`);

    if (!fs.existsSync(ROOT_DIR)) {
        console.error('Root directory not found!');
        return;
    }

    const agencies = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory());

    for (const agencyDirent of agencies) {
        const agencyName = agencyDirent.name;
        const agencyPath = path.join(ROOT_DIR, agencyName);

        console.log(`Processing Agency: ${agencyName}`);

        // Insert Agency
        const { data: agency, error: agencyError } = await supabase
            .from('agencies')
            .upsert({ name: agencyName }, { onConflict: 'name' })
            .select()
            .single();

        if (agencyError) {
            console.error(`Error inserting agency ${agencyName}:`, agencyError);
            continue;
        }

        const carriers = fs.readdirSync(agencyPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());

        for (const carrierDirent of carriers) {
            const carrierName = carrierDirent.name;
            const carrierPath = path.join(agencyPath, carrierName);
            console.log(`  Processing Carrier: ${carrierName}`);

            // Insert Carrier
            // Note: carrier name is not unique globally, but unique per agency ideally. 
            // For simplicity, we'll just insert/select based on name + agency_id
            let { data: carrier, error: carrierError } = await supabase
                .from('carriers')
                .select('*')
                .eq('agency_id', agency.id)
                .eq('name', carrierName)
                .single();

            if (!carrier) {
                const { data: newCarrier, error: newCarrierError } = await supabase
                    .from('carriers')
                    .insert({ agency_id: agency.id, name: carrierName, directory_path: carrierPath })
                    .select()
                    .single();
                carrier = newCarrier;
                carrierError = newCarrierError;
            }

            if (carrierError) {
                console.error(`  Error inserting carrier ${carrierName}:`, carrierError);
                continue;
            }

            // Process Files (Optional initial indexing)
            // We look for 'Policy' and 'Commission' folders if they exist, or just files in the carrier root if structure varies
            // Based on user query "Commision" and "Policy" folders seem to exist inside carrier.

            const subDirs = fs.readdirSync(carrierPath, { withFileTypes: true });

            for (const subDir of subDirs) {
                if (subDir.isDirectory()) {
                    const subDirPath = path.join(carrierPath, subDir.name);
                    let type = null;
                    if (subDir.name.toLowerCase().includes('policy') || subDir.name.toLowerCase().includes('policies')) type = 'Policy';
                    if (subDir.name.toLowerCase().includes('commission') || subDir.name.toLowerCase().includes('commision')) type = 'Commission';

                    if (type) {
                        const files = fs.readdirSync(subDirPath).filter(f => !fs.lstatSync(path.join(subDirPath, f)).isDirectory());
                        for (const file of files) {
                            const filePath = path.join(subDirPath, file);
                            // Check if file already exists in DB to avoid dupes
                            const { data: existingFile } = await supabase
                                .from('files')
                                .select('id')
                                .eq('carrier_id', carrier.id)
                                .eq('filename', file)
                                .single();

                            if (!existingFile) {
                                await supabase.from('files').insert({
                                    agency_id: agency.id,
                                    carrier_id: carrier.id,
                                    type: type,
                                    filename: file,
                                    is_local: true
                                });
                                console.log(`    Indexed file: ${file} (${type})`);
                            }
                        }
                    }
                }
            }
        }
    }
    console.log('Seeding completed.');
}

seed();
