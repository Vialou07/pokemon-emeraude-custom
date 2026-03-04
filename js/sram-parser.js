/**
 * sram-parser.js — Parse GBA SRAM save data to extract player party
 * Designed for pokeemerald-expansion (RH Hideout fork)
 *
 * Usage:
 *   const result = SRAMParser.extractParty(sramUint8Array);
 *   // result = { partyCount: 3, party: [ { species, heldItem, level, moves, ... }, ... ] }
 *
 *   const result2 = SRAMParser.extractPartyFromBase64(base64String);
 */
const SRAMParser = (function () {
    'use strict';

    // ===================== CONSTANTS =====================

    const SECTOR_SIZE = 4096;
    const SECTOR_DATA_SIZE = 3968;
    const SAVE_BLOCK_3_CHUNK_SIZE = 116;
    const NUM_SECTORS_PER_SLOT = 14;
    const SECTOR_SIGNATURE = 0x08012025;

    // Footer offsets within a 4096-byte sector
    const FOOTER_ID_OFFSET = SECTOR_DATA_SIZE + SAVE_BLOCK_3_CHUNK_SIZE; // 4084
    const FOOTER_SIGNATURE_OFFSET = FOOTER_ID_OFFSET + 4; // 4088
    const FOOTER_COUNTER_OFFSET = FOOTER_SIGNATURE_OFFSET + 4; // 4092

    // SaveBlock1 logical sector IDs
    const SB1_START = 1;
    const SB1_END = 4;

    // Party offsets within SaveBlock1
    const PARTY_COUNT_OFFSET = 0x234;
    const PARTY_ARRAY_OFFSET = 0x238;
    const PARTY_SIZE = 6;
    const POKEMON_SIZE = 100; // BoxPokemon(80) + battle data(20)

    // Flags array offset within SaveBlock1
    const FLAGS_OFFSET = 0x1270;
    // Badge flags: FLAG_BADGE01_GET = 2151 .. FLAG_BADGE08_GET = 2158
    const BADGE_FLAGS = [2151, 2152, 2153, 2154, 2155, 2156, 2157, 2158];

    // BoxPokemon field offsets
    const BOX_PERSONALITY = 0;
    const BOX_OT_ID = 4;
    const BOX_NICKNAME = 8;
    const BOX_SECURE = 32;
    const SUBSTRUCT_SIZE = 12;

    // Battle data offsets (within Pokemon struct, relative to struct start)
    const BATTLE_LEVEL = 84;
    const BATTLE_HP = 86;
    const BATTLE_MAX_HP = 88;
    const BATTLE_ATTACK = 90;
    const BATTLE_DEFENSE = 92;
    const BATTLE_SPEED = 94;
    const BATTLE_SP_ATTACK = 96;
    const BATTLE_SP_DEFENSE = 98;

    // Substruct ordering table — sSubstructOffsets[type][personality % 24]
    // Tells which array index (0-3) holds substruct of given type
    const SUBSTRUCT_OFFSETS = [
        [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3], // type 0 (Growth)
        [1, 1, 2, 3, 2, 3, 0, 0, 0, 0, 0, 0, 2, 3, 1, 1, 3, 2, 2, 3, 1, 1, 3, 2], // type 1 (Attacks)
        [2, 3, 1, 1, 3, 2, 2, 3, 1, 1, 3, 2, 0, 0, 0, 0, 0, 0, 3, 2, 3, 2, 1, 1], // type 2 (EVs)
        [3, 2, 3, 2, 1, 1, 3, 2, 3, 2, 1, 1, 3, 2, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0], // type 3 (Misc)
    ];

    // GBA character encoding → Unicode
    const GBA_CHARSET = {};
    // Uppercase A-Z
    for (let i = 0; i < 26; i++) GBA_CHARSET[0xBB + i] = String.fromCharCode(65 + i);
    // Lowercase a-z
    for (let i = 0; i < 26; i++) GBA_CHARSET[0xD5 + i] = String.fromCharCode(97 + i);
    // Digits 0-9
    for (let i = 0; i < 10; i++) GBA_CHARSET[0xA1 + i] = String.fromCharCode(48 + i);
    // Special characters
    Object.assign(GBA_CHARSET, {
        0x00: ' ', 0xAB: '!', 0xAC: '?', 0xAD: '.', 0xAE: '-',
        0xB0: '\u2026', 0xB1: '\u201C', 0xB2: '\u201D', 0xB3: '\u2018', 0xB4: '\u2019',
        0xB5: '\u2642', 0xB6: '\u2640', 0xBA: ':', 0x34: ',',
    });

    // ===================== HELPER FUNCTIONS =====================

    function readU8(data, offset) {
        return data[offset];
    }

    function readU16(data, offset) {
        return data[offset] | (data[offset + 1] << 8);
    }

    function readU32(data, offset) {
        return (data[offset] | (data[offset + 1] << 8) |
            (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
    }

    function decodeGBAString(data, offset, length) {
        let result = '';
        for (let i = 0; i < length; i++) {
            const byte = data[offset + i];
            if (byte === 0xFF) break; // EOS
            result += GBA_CHARSET[byte] || '';
        }
        return result;
    }

    // ===================== SECTOR PARSING =====================

    function reconstructSaveBlock1(sram) {
        const slots = [
            { startSector: 0, counter: 0, sectors: {}, validCount: 0 },
            { startSector: 14, counter: 0, sectors: {}, validCount: 0 }
        ];

        for (let slotIdx = 0; slotIdx < 2; slotIdx++) {
            const slot = slots[slotIdx];
            for (let i = 0; i < NUM_SECTORS_PER_SLOT; i++) {
                const physAddr = (slot.startSector + i) * SECTOR_SIZE;
                if (physAddr + SECTOR_SIZE > sram.length) continue;

                const sig = readU32(sram, physAddr + FOOTER_SIGNATURE_OFFSET);
                if (sig !== SECTOR_SIGNATURE) continue;

                const id = readU16(sram, physAddr + FOOTER_ID_OFFSET);
                const counter = readU32(sram, physAddr + FOOTER_COUNTER_OFFSET);

                if (id < NUM_SECTORS_PER_SLOT) {
                    slot.sectors[id] = physAddr;
                    if (counter > slot.counter) slot.counter = counter;
                    slot.validCount++;
                }
            }
        }

        // Pick the slot with the highest counter
        const active = (slots[1].counter > slots[0].counter && slots[1].validCount > 0)
            ? slots[1] : slots[0];

        if (active.validCount === 0) {
            throw new Error('Aucun slot de sauvegarde valide trouvé');
        }

        // Reconstruct SaveBlock1 from logical sectors 1-4
        const numChunks = SB1_END - SB1_START + 1;
        const sb1 = new Uint8Array(numChunks * SECTOR_DATA_SIZE);

        for (let id = SB1_START; id <= SB1_END; id++) {
            const physAddr = active.sectors[id];
            if (physAddr === undefined) {
                throw new Error(`Secteur SaveBlock1 #${id} manquant`);
            }
            const destOffset = (id - SB1_START) * SECTOR_DATA_SIZE;
            sb1.set(sram.subarray(physAddr, physAddr + SECTOR_DATA_SIZE), destOffset);
        }

        return sb1;
    }

    // ===================== POKEMON PARSING =====================

    function decryptSubstructs(data, offset, personality, otId) {
        const key = (personality ^ otId) >>> 0;
        const decrypted = new Uint8Array(SUBSTRUCT_SIZE * 4);

        for (let i = 0; i < 48; i += 4) {
            const enc = readU32(data, offset + BOX_SECURE + i);
            const dec = (enc ^ key) >>> 0;
            decrypted[i] = dec & 0xFF;
            decrypted[i + 1] = (dec >> 8) & 0xFF;
            decrypted[i + 2] = (dec >> 16) & 0xFF;
            decrypted[i + 3] = (dec >> 24) & 0xFF;
        }

        return decrypted;
    }

    function getSubstructOffset(personality, type) {
        return SUBSTRUCT_OFFSETS[type][personality % 24] * SUBSTRUCT_SIZE;
    }

    function parseGrowth(dec, off) {
        const w0 = readU16(dec, off);
        const w1 = readU16(dec, off + 2);
        return {
            species: w0 & 0x7FF,
            heldItem: w1 & 0x3FF,
            experience: readU32(dec, off + 4) & 0x1FFFFF,
            ppBonuses: dec[off + 8],
            friendship: dec[off + 9],
        };
    }

    function parseAttacks(dec, off) {
        return {
            moves: [
                readU16(dec, off) & 0x7FF,
                readU16(dec, off + 2) & 0x7FF,
                readU16(dec, off + 4) & 0x7FF,
                readU16(dec, off + 6) & 0x7FF,
            ],
            pp: [
                dec[off + 8] & 0x7F,
                dec[off + 9] & 0x7F,
                dec[off + 10] & 0x7F,
                dec[off + 11] & 0x7F,
            ]
        };
    }

    function parseEVs(dec, off) {
        return {
            hp: dec[off], attack: dec[off + 1], defense: dec[off + 2],
            speed: dec[off + 3], spAttack: dec[off + 4], spDefense: dec[off + 5],
        };
    }

    function parseMisc(dec, off) {
        const metInfo = readU16(dec, off + 2);
        const ivWord = readU32(dec, off + 4);
        const ribbons = readU32(dec, off + 8);
        return {
            pokerus: dec[off],
            dynamaxLevel: (metInfo >> 11) & 0xF,
            hpIV: ivWord & 0x1F,
            attackIV: (ivWord >> 5) & 0x1F,
            defenseIV: (ivWord >> 10) & 0x1F,
            speedIV: (ivWord >> 15) & 0x1F,
            spAttackIV: (ivWord >> 20) & 0x1F,
            spDefenseIV: (ivWord >> 25) & 0x1F,
            isEgg: (ivWord >> 30) & 1,
            abilityNum: (ribbons >> 29) & 3,
        };
    }

    function parsePokemon(sb1, offset) {
        const personality = readU32(sb1, offset + BOX_PERSONALITY);
        const otId = readU32(sb1, offset + BOX_OT_ID);

        if (personality === 0 && otId === 0) return null;

        const nickname = decodeGBAString(sb1, offset + BOX_NICKNAME, 10);
        const decrypted = decryptSubstructs(sb1, offset, personality, otId);

        const growth = parseGrowth(decrypted, getSubstructOffset(personality, 0));
        const attacks = parseAttacks(decrypted, getSubstructOffset(personality, 1));
        const evs = parseEVs(decrypted, getSubstructOffset(personality, 2));
        const misc = parseMisc(decrypted, getSubstructOffset(personality, 3));

        // Skip empty slots / eggs
        if (growth.species === 0) return null;

        return {
            personality: personality,
            otId: otId,
            species: growth.species,
            heldItem: growth.heldItem,
            nickname: nickname || 'Pokemon',
            level: readU8(sb1, offset + BATTLE_LEVEL),
            moves: attacks.moves.filter(m => m > 0),
            movesRaw: attacks.moves, // all 4 slots including zeros
            pp: attacks.pp,
            ppBonuses: growth.ppBonuses,
            hp: readU16(sb1, offset + BATTLE_HP),
            maxHP: readU16(sb1, offset + BATTLE_MAX_HP),
            attack: readU16(sb1, offset + BATTLE_ATTACK),
            defense: readU16(sb1, offset + BATTLE_DEFENSE),
            speed: readU16(sb1, offset + BATTLE_SPEED),
            spAttack: readU16(sb1, offset + BATTLE_SP_ATTACK),
            spDefense: readU16(sb1, offset + BATTLE_SP_DEFENSE),
            evs,
            ivs: {
                hp: misc.hpIV, attack: misc.attackIV, defense: misc.defenseIV,
                speed: misc.speedIV, spAttack: misc.spAttackIV, spDefense: misc.spDefenseIV
            },
            abilityNum: misc.abilityNum,
            isEgg: misc.isEgg === 1,
            friendship: growth.friendship,
            experience: growth.experience,
        };
    }

    // ===================== BADGE PARSING =====================

    function checkFlag(sb1, flagId) {
        const byteOffset = FLAGS_OFFSET + Math.floor(flagId / 8);
        const bitPos = flagId & 7;
        if (byteOffset >= sb1.length) return false;
        return ((sb1[byteOffset] >> bitPos) & 1) === 1;
    }

    function extractBadgesFromSB1(sb1) {
        return BADGE_FLAGS.map(flag => checkFlag(sb1, flag));
    }

    // ===================== PUBLIC API =====================

    function extractParty(sram) {
        if (!(sram instanceof Uint8Array)) {
            throw new Error('Les donnees SRAM doivent etre un Uint8Array');
        }

        const sb1 = reconstructSaveBlock1(sram);
        const partyCount = Math.min(readU8(sb1, PARTY_COUNT_OFFSET), PARTY_SIZE);

        const party = [];
        for (let i = 0; i < partyCount; i++) {
            const offset = PARTY_ARRAY_OFFSET + (i * POKEMON_SIZE);
            const pokemon = parsePokemon(sb1, offset);
            if (pokemon && !pokemon.isEgg) {
                party.push(pokemon);
            }
        }

        const badges = extractBadgesFromSB1(sb1);

        return { partyCount, party, badges };
    }

    function extractPartyFromBase64(base64Sram) {
        const binary = atob(base64Sram);
        const sram = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            sram[i] = binary.charCodeAt(i);
        }
        return extractParty(sram);
    }

    // ===================== ARENA MAILBOX =====================

    const ARENA_FLASH_SECTOR = 30;
    const ARENA_SECTOR_OFFSET = ARENA_FLASH_SECTOR * SECTOR_SIZE; // 122880
    const ARENA_MAGIC = 0x4152454E; // "AREN"
    const BTP_SIZE = 44; // sizeof(BattleTowerPokemon)

    // Reverse GBA charset: Unicode char → GBA byte
    const GBA_REVERSE_CHARSET = {};
    for (const [byte, char] of Object.entries(GBA_CHARSET)) {
        GBA_REVERSE_CHARSET[char] = parseInt(byte);
    }

    function writeU16(data, offset, value) {
        data[offset] = value & 0xFF;
        data[offset + 1] = (value >> 8) & 0xFF;
    }

    function writeU32(data, offset, value) {
        data[offset] = value & 0xFF;
        data[offset + 1] = (value >> 8) & 0xFF;
        data[offset + 2] = (value >> 16) & 0xFF;
        data[offset + 3] = (value >> 24) & 0xFF;
    }

    function encodeGBAString(str, maxLen) {
        const result = new Uint8Array(maxLen);
        result.fill(0xFF); // EOS
        for (let i = 0; i < str.length && i < maxLen; i++) {
            const gbaB = GBA_REVERSE_CHARSET[str[i]];
            if (gbaB !== undefined) {
                result[i] = gbaB;
            }
        }
        return result;
    }

    // Serialize one Pokemon into BattleTowerPokemon format (44 bytes)
    function serializeBTP(mon) {
        const buf = new Uint8Array(BTP_SIZE);
        writeU16(buf, 0, mon.species || 0);
        writeU16(buf, 2, mon.heldItem || 0);

        // moves[4] as u16 — handle both raw IDs and {id, name} objects
        const rawMoves = mon.movesRaw || mon.moves || [];
        for (let i = 0; i < 4; i++) {
            var m = rawMoves[i];
            var moveId = (typeof m === 'object' && m !== null) ? (m.id || 0) : (m || 0);
            writeU16(buf, 4 + i * 2, moveId);
        }

        buf[12] = mon.level || 1;
        buf[13] = mon.ppBonuses || 0;

        // EVs
        const evs = mon.evs || {};
        buf[14] = evs.hp || 0;
        buf[15] = evs.attack || 0;
        buf[16] = evs.defense || 0;
        buf[17] = evs.speed || 0;
        buf[18] = evs.spAttack || 0;
        buf[19] = evs.spDefense || 0;

        // otId
        writeU32(buf, 20, mon.otId || (Math.random() * 0xFFFFFFFF >>> 0));

        // IV bitfield: hp:5, atk:5, def:5, spd:5, spa:5, spd:5, gap:1, abilityNum:1
        const ivs = mon.ivs || {};
        let ivWord = (ivs.hp || 0) & 0x1F;
        ivWord |= ((ivs.attack || 0) & 0x1F) << 5;
        ivWord |= ((ivs.defense || 0) & 0x1F) << 10;
        ivWord |= ((ivs.speed || 0) & 0x1F) << 15;
        ivWord |= ((ivs.spAttack || 0) & 0x1F) << 20;
        ivWord |= ((ivs.spDefense || 0) & 0x1F) << 25;
        // gap bit = 0
        ivWord |= ((mon.abilityNum || 0) & 1) << 31;
        writeU32(buf, 24, ivWord >>> 0);

        // personality
        writeU32(buf, 28, mon.personality || (Math.random() * 0xFFFFFFFF >>> 0));

        // nickname (11 bytes, GBA encoded)
        const nick = encodeGBAString(mon.nickname || '', 11);
        for (let i = 0; i < 11; i++) buf[32 + i] = nick[i];

        // friendship
        buf[43] = mon.friendship || 0;

        return buf;
    }

    /**
     * Write an ArenaMailbox into SRAM sector 30.
     * @param {Uint8Array} sram - The full SRAM data (will be modified in place)
     * @param {object} mailboxData - { gymId, party: [{species, level, moves, ...}] }
     * @returns {Uint8Array} The modified SRAM
     */
    function writeArenaMailbox(sram, mailboxData) {
        if (ARENA_SECTOR_OFFSET + SECTOR_SIZE > sram.length) {
            throw new Error('SRAM trop petit pour le secteur Arena');
        }

        // Clear the sector
        for (let i = 0; i < SECTOR_SIZE; i++) {
            sram[ARENA_SECTOR_OFFSET + i] = 0;
        }

        const base = ARENA_SECTOR_OFFSET;
        const party = mailboxData.party || [];
        const count = Math.min(party.length, 6);

        // Write ArenaMailbox header
        writeU32(sram, base + 0, ARENA_MAGIC);
        sram[base + 4] = 1; // active
        sram[base + 5] = mailboxData.gymId || 0;
        sram[base + 6] = count;
        sram[base + 7] = 0; // result = pending

        // Write party (BattleTowerPokemon × 6, starting at offset 8)
        for (let i = 0; i < count; i++) {
            const btp = serializeBTP(party[i]);
            sram.set(btp, base + 8 + i * BTP_SIZE);
        }

        return sram;
    }

    /**
     * Read the arena battle result from SRAM sector 30.
     * @param {Uint8Array} sram - The full SRAM data
     * @returns {object} { valid, active, gymId, result }
     */
    function readArenaResult(sram) {
        if (ARENA_SECTOR_OFFSET + 8 > sram.length) {
            return { valid: false, active: false, result: 0 };
        }

        const base = ARENA_SECTOR_OFFSET;
        const magic = readU32(sram, base);

        return {
            valid: magic === ARENA_MAGIC,
            active: sram[base + 4] === 1,
            gymId: sram[base + 5],
            result: sram[base + 7], // 0=pending, 1=win, 2=loss
        };
    }

    /**
     * Clear the arena mailbox in SRAM (set active=0).
     * @param {Uint8Array} sram - The full SRAM data (modified in place)
     */
    function clearArenaMailbox(sram) {
        if (ARENA_SECTOR_OFFSET + 8 > sram.length) return;
        sram[ARENA_SECTOR_OFFSET + 4] = 0; // active = 0
    }

    // ===================== SAVEBLOCK2 PARSING =====================

    function findActiveSaveSlot(sram) {
        var slots = [
            { startSector: 0, counter: 0, sectors: {}, validCount: 0 },
            { startSector: 14, counter: 0, sectors: {}, validCount: 0 }
        ];

        for (var slotIdx = 0; slotIdx < 2; slotIdx++) {
            var slot = slots[slotIdx];
            for (var i = 0; i < NUM_SECTORS_PER_SLOT; i++) {
                var physAddr = (slot.startSector + i) * SECTOR_SIZE;
                if (physAddr + SECTOR_SIZE > sram.length) continue;
                var sig = readU32(sram, physAddr + FOOTER_SIGNATURE_OFFSET);
                if (sig !== SECTOR_SIGNATURE) continue;
                var id = readU16(sram, physAddr + FOOTER_ID_OFFSET);
                var counter = readU32(sram, physAddr + FOOTER_COUNTER_OFFSET);
                if (id < NUM_SECTORS_PER_SLOT) {
                    slot.sectors[id] = physAddr;
                    if (counter > slot.counter) slot.counter = counter;
                    slot.validCount++;
                }
            }
        }

        return (slots[1].counter > slots[0].counter && slots[1].validCount > 0)
            ? slots[1] : slots[0];
    }

    function reconstructSaveBlock2(sram) {
        var active = findActiveSaveSlot(sram);
        var physAddr = active.sectors[0]; // sector ID 0 = SaveBlock2
        if (physAddr === undefined) return null;
        return sram.subarray(physAddr, physAddr + SECTOR_DATA_SIZE);
    }

    // ===================== PROFILE EXTRACTION =====================

    // SaveBlock2 offsets
    var SB2_PLAYER_NAME = 0x00;
    var SB2_PLAYER_GENDER = 0x08;
    var SB2_PLAY_TIME_HOURS = 0x0E;
    var SB2_PLAY_TIME_MINUTES = 0x10;
    var SB2_PLAY_TIME_SECONDS = 0x11;
    var SB2_ENCRYPTION_KEY = 0xAC;

    // SaveBlock1 offsets
    var SB1_MONEY = 0x490;

    // Game stats: SaveBlock1 offset 0x159C, each stat is u32 (4 bytes)
    var GAME_STATS_OFFSET = 0x159C;
    var STAT_SAVED_GAME = 0;
    var STAT_STEPS = 5;
    var STAT_TOTAL_BATTLES = 7;
    var STAT_WILD_BATTLES = 8;
    var STAT_TRAINER_BATTLES = 9;
    var STAT_ENTERED_HOF = 10;
    var STAT_POKEMON_CAPTURES = 11;
    var STAT_FISHING_ENCOUNTERS = 12;
    var STAT_HATCHED_EGGS = 13;
    var STAT_EVOLVED_POKEMON = 14;
    var STAT_USED_POKECENTER = 15;
    var STAT_POKEMON_TRADES = 21;
    var STAT_USED_SPLASH = 26;
    var STAT_USED_STRUGGLE = 27;
    var STAT_JUMPED_LEDGES = 43;

    function readGameStat(sb1, statIndex, encryptionKey) {
        var raw = readU32(sb1, GAME_STATS_OFFSET + statIndex * 4);
        return (raw ^ encryptionKey) >>> 0;
    }

    function extractProfile(sram) {
        if (!(sram instanceof Uint8Array)) {
            throw new Error('Les donnees SRAM doivent etre un Uint8Array');
        }

        var sb1 = reconstructSaveBlock1(sram);
        var sb2 = reconstructSaveBlock2(sram);
        if (!sb2) throw new Error('SaveBlock2 introuvable');

        var encryptionKey = readU32(sb2, SB2_ENCRYPTION_KEY);

        // Player info from SaveBlock2
        var playerName = decodeGBAString(sb2, SB2_PLAYER_NAME, 8);
        var gender = readU8(sb2, SB2_PLAYER_GENDER);
        var playTimeHours = readU16(sb2, SB2_PLAY_TIME_HOURS);
        var playTimeMinutes = readU8(sb2, SB2_PLAY_TIME_MINUTES);
        var playTimeSeconds = readU8(sb2, SB2_PLAY_TIME_SECONDS);

        // Money (XORed with encryption key)
        var moneyRaw = readU32(sb1, SB1_MONEY);
        var money = (moneyRaw ^ encryptionKey) >>> 0;
        // Sanity check: money should be < 1M in Pokemon
        if (money > 9999999) money = moneyRaw; // fallback if not encrypted

        // Badges
        var badges = extractBadgesFromSB1(sb1);
        var badgeCount = badges.filter(function(b) { return b; }).length;

        // Party
        var partyCount = Math.min(readU8(sb1, PARTY_COUNT_OFFSET), PARTY_SIZE);
        var party = [];
        for (var i = 0; i < partyCount; i++) {
            var offset = PARTY_ARRAY_OFFSET + (i * POKEMON_SIZE);
            var pokemon = parsePokemon(sb1, offset);
            if (pokemon && !pokemon.isEgg) {
                party.push({
                    species: pokemon.species,
                    nickname: pokemon.nickname,
                    level: pokemon.level,
                    heldItem: pokemon.heldItem,
                    hp: pokemon.hp,
                    maxHP: pokemon.maxHP,
                    moves: pokemon.moves,
                });
            }
        }

        // Game stats (each XORed with encryption key)
        var stats = {
            saves: readGameStat(sb1, STAT_SAVED_GAME, encryptionKey),
            steps: readGameStat(sb1, STAT_STEPS, encryptionKey),
            totalBattles: readGameStat(sb1, STAT_TOTAL_BATTLES, encryptionKey),
            wildBattles: readGameStat(sb1, STAT_WILD_BATTLES, encryptionKey),
            trainerBattles: readGameStat(sb1, STAT_TRAINER_BATTLES, encryptionKey),
            hallOfFame: readGameStat(sb1, STAT_ENTERED_HOF, encryptionKey),
            pokemonCaught: readGameStat(sb1, STAT_POKEMON_CAPTURES, encryptionKey),
            fishingEncounters: readGameStat(sb1, STAT_FISHING_ENCOUNTERS, encryptionKey),
            eggsHatched: readGameStat(sb1, STAT_HATCHED_EGGS, encryptionKey),
            pokemonEvolved: readGameStat(sb1, STAT_EVOLVED_POKEMON, encryptionKey),
            pokecenterVisits: readGameStat(sb1, STAT_USED_POKECENTER, encryptionKey),
            pokemonTraded: readGameStat(sb1, STAT_POKEMON_TRADES, encryptionKey),
            usedSplash: readGameStat(sb1, STAT_USED_SPLASH, encryptionKey),
            usedStruggle: readGameStat(sb1, STAT_USED_STRUGGLE, encryptionKey),
            ledgesJumped: readGameStat(sb1, STAT_JUMPED_LEDGES, encryptionKey),
        };

        // Sanity check on stats — if all look absurdly high, encryptionKey might not apply
        if (stats.steps > 99999999 || stats.totalBattles > 99999) {
            // Try without encryption
            stats = {
                saves: readU32(sb1, GAME_STATS_OFFSET + STAT_SAVED_GAME * 4),
                steps: readU32(sb1, GAME_STATS_OFFSET + STAT_STEPS * 4),
                totalBattles: readU32(sb1, GAME_STATS_OFFSET + STAT_TOTAL_BATTLES * 4),
                wildBattles: readU32(sb1, GAME_STATS_OFFSET + STAT_WILD_BATTLES * 4),
                trainerBattles: readU32(sb1, GAME_STATS_OFFSET + STAT_TRAINER_BATTLES * 4),
                hallOfFame: readU32(sb1, GAME_STATS_OFFSET + STAT_ENTERED_HOF * 4),
                pokemonCaught: readU32(sb1, GAME_STATS_OFFSET + STAT_POKEMON_CAPTURES * 4),
                fishingEncounters: readU32(sb1, GAME_STATS_OFFSET + STAT_FISHING_ENCOUNTERS * 4),
                eggsHatched: readU32(sb1, GAME_STATS_OFFSET + STAT_HATCHED_EGGS * 4),
                pokemonEvolved: readU32(sb1, GAME_STATS_OFFSET + STAT_EVOLVED_POKEMON * 4),
                pokecenterVisits: readU32(sb1, GAME_STATS_OFFSET + STAT_USED_POKECENTER * 4),
                pokemonTraded: readU32(sb1, GAME_STATS_OFFSET + STAT_POKEMON_TRADES * 4),
                usedSplash: readU32(sb1, GAME_STATS_OFFSET + STAT_USED_SPLASH * 4),
                usedStruggle: readU32(sb1, GAME_STATS_OFFSET + STAT_USED_STRUGGLE * 4),
                ledgesJumped: readU32(sb1, GAME_STATS_OFFSET + STAT_JUMPED_LEDGES * 4),
            };
        }

        // Highest level Pokemon
        var maxLevel = 0;
        party.forEach(function(p) { if (p.level > maxLevel) maxLevel = p.level; });

        return {
            playerName: playerName,
            gender: gender,
            playTimeHours: playTimeHours,
            playTimeMinutes: playTimeMinutes,
            playTimeSeconds: playTimeSeconds,
            money: money,
            badges: badges,
            badgeCount: badgeCount,
            party: party,
            partyCount: party.length,
            maxLevel: maxLevel,
            stats: stats,
        };
    }

    return {
        extractParty,
        extractPartyFromBase64,
        extractProfile,
        writeArenaMailbox,
        readArenaResult,
        clearArenaMailbox
    };
})();

if (typeof window !== 'undefined') window.SRAMParser = SRAMParser;
if (typeof module !== 'undefined' && module.exports) module.exports = SRAMParser;
