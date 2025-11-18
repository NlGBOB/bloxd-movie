const fs = require('fs').promises;
const path = require('path');
const MAP_FILE = path.join(__dirname, 'block_texture_map.json');
const OUTPUT_ID_LIST_FILE = path.join(__dirname, 'included_block_ids.json');

async function main() {
    try {
        console.log(`Reading block data from ${path.basename(MAP_FILE)}...`);
        const mapData = JSON.parse(await fs.readFile(MAP_FILE, 'utf-8'));

        const includedBlockIds = new Set();

        const blockEntries = Object.entries(mapData);
        console.log(`Scanning ${blockEntries.length} total blocks from source file...`);

        for (const [blockId, blockData] of blockEntries) {
            if (blockData.name.includes("Slab")) {
                continue; // Skip this block
            }

            includedBlockIds.add(parseInt(blockId, 10));
        }

        const sortedBlockIds = Array.from(includedBlockIds).sort((a, b) => a - b);

        console.log(`\nFound ${sortedBlockIds.length} blocks that are included in the final texture index.`);
        console.log(`Writing list to ${path.basename(OUTPUT_ID_LIST_FILE)}...`);

        await fs.writeFile(OUTPUT_ID_LIST_FILE, JSON.stringify(sortedBlockIds, null, 2));

        console.log("Done!");

    } catch (error) {
        console.error('\nAn unrecoverable error occurred:', error);
        process.exit(1);
    }
}

main();