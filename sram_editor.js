// ============================================================
// SRAM Editor for Pokemon Emerald (pokeemerald-expansion)
// Parses and modifies GBA save files (128KB SRAM)
// ============================================================
const SRAMEditor = (() => {
    'use strict';

    // ---- Constants ----
    const SECTOR_SIZE = 4096;
    const SECTOR_DATA_SIZE = 3968;
    const SECTORS_PER_SLOT = 14;
    const SECTOR_SIGNATURE = 0x08012025;
    const SRAM_SIZE = 32 * SECTOR_SIZE; // 131072 = 128KB

    // Footer offsets within a sector
    const FOOTER_ID     = 0xFF4;
    const FOOTER_CHKSUM = 0xFF6;
    const FOOTER_SIG    = 0xFF8;
    const FOOTER_CTR    = 0xFFC;

    // SaveBlock1 offsets (within reconstructed SB1 buffer)
    const SB1_PARTY_COUNT = 0x234;
    const SB1_PARTY_START = 0x238;
    const PARTY_MAX = 6;
    const POKEMON_SIZE = 100; // Party Pokemon
    const BOXMON_SIZE = 80;

    // BoxPokemon field offsets
    const BM_PERSONALITY = 0x00;
    const BM_OTID       = 0x04;
    const BM_NICKNAME    = 0x08;
    const BM_NICKNAME_LEN = 10;
    const BM_CHECKSUM    = 0x1C;
    const BM_HPLOST_WORD = 0x1E; // contains shinyModifier bit 14
    const BM_SECURE      = 0x20;
    const BM_SECURE_SIZE = 48;

    // Party-only fields (offset from start of Pokemon struct)
    const PM_LEVEL  = 0x54;
    const PM_HP     = 0x56;
    const PM_MAXHP  = 0x58;
    const PM_ATK    = 0x5A;
    const PM_DEF    = 0x5C;
    const PM_SPE    = 0x5E;
    const PM_SPA    = 0x60;
    const PM_SPD    = 0x62;

    // Substruct permutation table (personality % 24)
    const SUB_ORDER = [
        [0,0,0,0,0,0, 1,1,2,3,2,3, 1,1,2,3,2,3, 1,1,2,3,2,3],
        [1,1,2,3,2,3, 0,0,0,0,0,0, 2,3,1,1,3,2, 2,3,1,1,3,2],
        [2,3,1,1,3,2, 2,3,1,1,3,2, 0,0,0,0,0,0, 3,2,3,2,1,1],
        [3,2,3,2,1,1, 3,2,3,2,1,1, 3,2,3,2,1,1, 0,0,0,0,0,0],
    ];

    // Nature stat modifiers: NATURES[nature] = [boosted_stat_idx, reduced_stat_idx]
    // Stat indices: 0=Atk, 1=Def, 2=Spe, 3=SpA, 4=SpD
    // When boosted==reduced → neutral nature
    const NATURES = [
        [0,0],[0,1],[0,2],[0,3],[0,4], // Hardy,Lonely,Brave,Adamant,Naughty
        [1,0],[1,1],[1,2],[1,3],[1,4], // Bold,Docile,Relaxed,Impish,Lax
        [2,0],[2,1],[2,2],[2,3],[2,4], // Timid,Hasty,Serious,Jolly,Naive
        [3,0],[3,1],[3,2],[3,3],[3,4], // Modest,Mild,Quiet,Bashful,Rash
        [4,0],[4,1],[4,2],[4,3],[4,4], // Calm,Gentle,Sassy,Careful,Quirky
    ];

    const NATURE_NAMES = [
        'Hardy','Lonely','Brave','Adamant','Naughty',
        'Bold','Docile','Relaxed','Impish','Lax',
        'Timid','Hasty','Serious','Jolly','Naive',
        'Modest','Mild','Quiet','Bashful','Rash',
        'Calm','Gentle','Sassy','Careful','Quirky',
    ];

    // ---- GBA Character Map ----
    const GBA_CHAR = (() => {
        const m = {};
        m[0x00] = ' ';
        for (let i = 0; i < 26; i++) m[0xBB + i] = String.fromCharCode(65 + i);
        for (let i = 0; i < 26; i++) m[0xD5 + i] = String.fromCharCode(97 + i);
        for (let i = 0; i < 10; i++) m[0xA1 + i] = String.fromCharCode(48 + i);
        m[0xAB]='!'; m[0xAC]='?'; m[0xAD]='.'; m[0xAE]='-'; m[0xAF]='·';
        m[0xB0]='…'; m[0xB1]='\u201C'; m[0xB2]='\u201D';
        m[0xB3]='\u2018'; m[0xB4]='\u2019';
        m[0xB5]='♂'; m[0xB6]='♀'; m[0xB8]=','; m[0xB9]='×'; m[0xBA]='/';
        m[0xF0]=':';
        m[0x01]='À'; m[0x02]='Á'; m[0x03]='Â'; m[0x04]='Ç';
        m[0x05]='È'; m[0x06]='É'; m[0x07]='Ê'; m[0x08]='Ë';
        m[0x16]='à'; m[0x17]='á'; m[0x19]='ç';
        m[0x1A]='è'; m[0x1B]='é'; m[0x1C]='ê'; m[0x1D]='ë';
        m[0x20]='î'; m[0x21]='ï'; m[0x22]='ò'; m[0x23]='ó'; m[0x24]='ô';
        m[0x26]='ù'; m[0x27]='ú'; m[0x28]='û'; m[0x29]='ñ';
        return m;
    })();

    function decodeGBAString(bytes) {
        let s = '';
        for (const b of bytes) {
            if (b === 0xFF) break;
            s += GBA_CHAR[b] || '?';
        }
        return s;
    }

    // ---- Helpers ----
    function u16(view, off) { return view.getUint16(off, true); }
    function u32(view, off) { return view.getUint32(off, true); }
    function w16(view, off, v) { view.setUint16(off, v, true); }

    // ---- Stat calculation ----
    function getNatureMod(nature, statIdx) {
        // statIdx: 0=Atk, 1=Def, 2=Spe, 3=SpA, 4=SpD (HP has no nature mod)
        if (nature < 0 || nature >= 25) return 1.0;
        const [boost, reduce] = NATURES[nature];
        if (boost === reduce) return 1.0;
        if (statIdx === boost) return 1.1;
        if (statIdx === reduce) return 0.9;
        return 1.0;
    }

    function calcHP(base, iv, ev, level) {
        // Shedinja (base HP=1) always has 1 HP, but we just use the formula
        return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
    }

    function calcStat(base, iv, ev, level, natureMod) {
        return Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * natureMod);
    }

    // Reverse-engineer base stat from known stat, IV, EV, level, nature
    function findBaseHP(stat, iv, ev, level) {
        for (let base = 1; base <= 255; base++) {
            if (calcHP(base, iv, ev, level) === stat) return base;
        }
        return null;
    }

    function findBaseStat(stat, iv, ev, level, natureMod) {
        for (let base = 1; base <= 255; base++) {
            if (calcStat(base, iv, ev, level, natureMod) === stat) return base;
        }
        return null;
    }

    // ---- Sector checksum (fold-32-to-16) ----
    function sectorChecksum(data, size) {
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let sum = 0;
        for (let i = 0; i < (size >>> 2); i++) {
            sum = (sum + v.getUint32(i * 4, true)) >>> 0;
        }
        return ((sum >>> 16) + (sum & 0xFFFF)) & 0xFFFF;
    }

    // ---- Pokemon checksum (sum of u16s in decrypted secure) ----
    function pokemonChecksum(secureBytes) {
        const v = new DataView(secureBytes.buffer, secureBytes.byteOffset, secureBytes.byteLength);
        let sum = 0;
        for (let i = 0; i < 24; i++) {
            sum = (sum + v.getUint16(i * 2, true)) & 0xFFFFFFFF;
        }
        return sum & 0xFFFF;
    }

    // ---- Decrypt / Encrypt secure region ----
    function xorSecure(secureBytes, personality, otId) {
        const v = new DataView(secureBytes.buffer, secureBytes.byteOffset, secureBytes.byteLength);
        for (let i = 0; i < 12; i++) {
            const off = i * 4;
            const val = v.getUint32(off, true);
            v.setUint32(off, (val ^ personality ^ otId) >>> 0, true);
        }
    }

    // ---- Parse SRAM ----
    function parse(sramBuffer) {
        if (!(sramBuffer instanceof Uint8Array)) throw new Error('Expected Uint8Array');
        if (sramBuffer.length < SRAM_SIZE) throw new Error(`SRAM too small: ${sramBuffer.length} bytes (need ${SRAM_SIZE})`);

        const view = new DataView(sramBuffer.buffer, sramBuffer.byteOffset, sramBuffer.byteLength);

        function readSector(physIdx) {
            const base = physIdx * SECTOR_SIZE;
            return {
                physIdx,
                id:        u16(view, base + FOOTER_ID),
                checksum:  u16(view, base + FOOTER_CHKSUM),
                signature: u32(view, base + FOOTER_SIG),
                counter:   u32(view, base + FOOTER_CTR),
            };
        }

        const slotsInfo = [[], []];
        for (let i = 0; i < SECTORS_PER_SLOT; i++) {
            slotsInfo[0].push(readSector(i));
            slotsInfo[1].push(readSector(i + SECTORS_PER_SLOT));
        }

        const maxCtr = s => Math.max(...s.map(x => x.counter));
        const activeSlotIdx = maxCtr(slotsInfo[0]) >= maxCtr(slotsInfo[1]) ? 0 : 1;
        const activeSlot = slotsInfo[activeSlotIdx];

        const logicalSectors = new Array(SECTORS_PER_SLOT).fill(null);
        for (const sec of activeSlot) {
            if (sec.signature === SECTOR_SIGNATURE && sec.id < SECTORS_PER_SLOT) {
                logicalSectors[sec.id] = sec;
            }
        }

        for (let i = 0; i < SECTORS_PER_SLOT; i++) {
            if (!logicalSectors[i]) throw new Error(`Missing sector ${i} in active save slot`);
        }

        const sector1PhysBase = logicalSectors[1].physIdx * SECTOR_SIZE;

        const partyCount = Math.min(sramBuffer[sector1PhysBase + SB1_PARTY_COUNT], PARTY_MAX);
        const party = [];

        for (let i = 0; i < partyCount; i++) {
            const sb1Offset = SB1_PARTY_START + i * POKEMON_SIZE;
            const sramOffset = sector1PhysBase + sb1Offset;
            const raw = sramBuffer.slice(sramOffset, sramOffset + POKEMON_SIZE);
            const mon = parsePokemon(raw);
            mon._partyIndex = i;
            mon._sramOffset = sramOffset;
            party.push(mon);
        }

        return { activeSlotIdx, logicalSectors, partyCount, party, sram: sramBuffer };
    }

    // ---- Parse a single Pokemon ----
    function parsePokemon(raw) {
        const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

        const personality = u32(v, BM_PERSONALITY);
        const otId       = u32(v, BM_OTID);
        const nickname   = decodeGBAString(raw.slice(BM_NICKNAME, BM_NICKNAME + BM_NICKNAME_LEN));
        const checksum   = u16(v, BM_CHECKSUM);
        const word1E     = u16(v, BM_HPLOST_WORD);
        const shinyModifier = (word1E >>> 14) & 1;

        // Decrypt secure region
        const secure = raw.slice(BM_SECURE, BM_SECURE + BM_SECURE_SIZE);
        xorSecure(secure, personality, otId);

        const calcChk = pokemonChecksum(secure);
        const checksumOk = (calcChk === checksum);

        const perm = personality % 24;
        const subIdx = [SUB_ORDER[0][perm], SUB_ORDER[1][perm], SUB_ORDER[2][perm], SUB_ORDER[3][perm]];
        const sv = new DataView(secure.buffer, secure.byteOffset, secure.byteLength);

        // Substruct 0: growth
        const s0 = subIdx[0] * 12;
        const species    = u16(sv, s0) & 0x7FF;
        const heldItem   = u16(sv, s0 + 2) & 0x3FF;
        const experience = u32(sv, s0 + 4) & 0x1FFFFF;
        const friendship = secure[s0 + 8];

        // Substruct 1: moves
        const s1 = subIdx[1] * 12;
        const moves = [u16(sv,s1)&0x7FF, u16(sv,s1+2)&0x7FF, u16(sv,s1+4)&0x7FF, u16(sv,s1+6)&0x7FF];

        // Substruct 2: EVs
        const s2 = subIdx[2] * 12;
        const evs = {
            hp: secure[s2], attack: secure[s2+1], defense: secure[s2+2],
            speed: secure[s2+3], spAttack: secure[s2+4], spDefense: secure[s2+5],
        };

        // Substruct 3: IVs
        const s3 = subIdx[3] * 12;
        const ivWord = u32(sv, s3 + 4);
        const ivs = {
            hp:       (ivWord>>>0)&0x1F,  attack:   (ivWord>>>5)&0x1F,
            defense:  (ivWord>>>10)&0x1F, speed:    (ivWord>>>15)&0x1F,
            spAttack: (ivWord>>>20)&0x1F, spDefense:(ivWord>>>25)&0x1F,
        };
        const isEgg = (ivWord >>> 30) & 1;

        // Shiny
        const shinyVal = ((otId>>>16)^(otId&0xFFFF)^(personality>>>16)^(personality&0xFFFF));
        const isShiny = ((shinyVal < 8) ? 1 : 0) ^ shinyModifier;

        // Nature
        const nature = personality % 25;

        // Party stats
        const level = raw[PM_LEVEL];
        const hp    = u16(v, PM_HP);
        const maxHP = u16(v, PM_MAXHP);
        const stats = {
            attack: u16(v,PM_ATK), defense: u16(v,PM_DEF), speed: u16(v,PM_SPE),
            spAttack: u16(v,PM_SPA), spDefense: u16(v,PM_SPD),
        };

        // Reverse-engineer base stats from current stats + current EVs
        const STAT_KEYS = [
            { key:'attack',   ivKey:'attack',   evKey:'attack',   idx:0 },
            { key:'defense',  ivKey:'defense',  evKey:'defense',  idx:1 },
            { key:'speed',    ivKey:'speed',    evKey:'speed',    idx:2 },
            { key:'spAttack', ivKey:'spAttack', evKey:'spAttack', idx:3 },
            { key:'spDefense',ivKey:'spDefense',evKey:'spDefense',idx:4 },
        ];
        const baseStats = {};
        baseStats.hp = findBaseHP(maxHP, ivs.hp, evs.hp, level);
        for (const s of STAT_KEYS) {
            const nmod = getNatureMod(nature, s.idx);
            baseStats[s.key] = findBaseStat(stats[s.key], ivs[s.ivKey], evs[s.evKey], level, nmod);
        }

        return {
            personality, otId, nickname, species, heldItem, experience, friendship,
            moves, evs, ivs, level, hp, maxHP, stats,
            isShiny: !!isShiny, isEgg: !!isEgg, checksumOk,
            nature, natureName: NATURE_NAMES[nature] || '?',
            baseStats,                         // reverse-engineered base stats
            _origEvs: { ...evs },              // original EVs (before user edits)
            _raw: raw, _secure: secure, _subIdx: subIdx, _perm: perm,
        };
    }

    // ---- Write EVs + recalculate party stats ----
    function writeEVs(save, partyIndex, newEVs) {
        const mon = save.party[partyIndex];
        if (!mon) throw new Error(`No Pokemon at party index ${partyIndex}`);

        // Validate
        const vals = [newEVs.hp, newEVs.attack, newEVs.defense, newEVs.speed, newEVs.spAttack, newEVs.spDefense];
        const total = vals.reduce((a, b) => a + b, 0);
        if (total > 510) throw new Error(`EV total ${total} > 510`);
        for (const val of vals) {
            if (val < 0 || val > 252) throw new Error(`EV value ${val} out of range 0-252`);
        }

        // Update decrypted secure data (EVs in substruct 2)
        const s2 = mon._subIdx[2] * 12;
        mon._secure[s2 + 0] = newEVs.hp;
        mon._secure[s2 + 1] = newEVs.attack;
        mon._secure[s2 + 2] = newEVs.defense;
        mon._secure[s2 + 3] = newEVs.speed;
        mon._secure[s2 + 4] = newEVs.spAttack;
        mon._secure[s2 + 5] = newEVs.spDefense;

        // Recalculate Pokemon checksum
        const newChk = pokemonChecksum(mon._secure);
        const rawView = new DataView(mon._raw.buffer, mon._raw.byteOffset, mon._raw.byteLength);
        w16(rawView, BM_CHECKSUM, newChk);

        // Re-encrypt secure region and write to raw
        const encrypted = new Uint8Array(BM_SECURE_SIZE);
        encrypted.set(mon._secure);
        xorSecure(encrypted, mon.personality, mon.otId);
        mon._raw.set(encrypted, BM_SECURE);

        // ---- Recalculate party stats from base stats ----
        const nature = mon.nature;
        const level = mon.level;
        const bs = mon.baseStats;

        if (bs.hp != null) {
            const newMaxHP = calcHP(bs.hp, mon.ivs.hp, newEVs.hp, level);
            const hpDelta = newMaxHP - mon.maxHP;
            const newHP = Math.max(1, Math.min(newMaxHP, mon.hp + hpDelta));
            w16(rawView, PM_MAXHP, newMaxHP);
            w16(rawView, PM_HP, newHP);
            mon.maxHP = newMaxHP;
            mon.hp = newHP;
        }

        const STAT_MAP = [
            { key:'attack',   evKey:'attack',   ivKey:'attack',   off:PM_ATK, idx:0 },
            { key:'defense',  evKey:'defense',  ivKey:'defense',  off:PM_DEF, idx:1 },
            { key:'speed',    evKey:'speed',    ivKey:'speed',    off:PM_SPE, idx:2 },
            { key:'spAttack', evKey:'spAttack', ivKey:'spAttack', off:PM_SPA, idx:3 },
            { key:'spDefense',evKey:'spDefense',ivKey:'spDefense',off:PM_SPD, idx:4 },
        ];

        for (const sm of STAT_MAP) {
            const base = bs[sm.key];
            if (base != null) {
                const nmod = getNatureMod(nature, sm.idx);
                const newVal = calcStat(base, mon.ivs[sm.ivKey], newEVs[sm.evKey], level, nmod);
                w16(rawView, sm.off, newVal);
                mon.stats[sm.key] = newVal;
            }
        }

        // Copy modified Pokemon data back to SRAM
        save.sram.set(mon._raw, mon._sramOffset);

        // Recalculate sector checksum
        const sectorPhysIdx = Math.floor(mon._sramOffset / SECTOR_SIZE);
        const sectorBase = sectorPhysIdx * SECTOR_SIZE;
        const sectorData = save.sram.slice(sectorBase, sectorBase + SECTOR_DATA_SIZE);
        const newSectorChk = sectorChecksum(sectorData, SECTOR_DATA_SIZE);
        const sramView = new DataView(save.sram.buffer, save.sram.byteOffset, save.sram.byteLength);
        w16(sramView, sectorBase + FOOTER_CHKSUM, newSectorChk);

        // Update parsed EVs
        mon.evs = { ...newEVs };
        mon.checksumOk = true;

        return save;
    }

    // ---- Base64 helpers ----
    function fromBase64(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    function toBase64(arr) {
        let bin = '';
        for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
        return btoa(bin);
    }

    function evTotal(evs) {
        return evs.hp + evs.attack + evs.defense + evs.speed + evs.spAttack + evs.spDefense;
    }

    // ---- Read badge count from SaveBlock1 flags ----
    function readBadges(save) {
        // Badge flags: FLAG_BADGE01_GET=0x867 .. FLAG_BADGE08_GET=0x86E
        // flags array at SB1 offset 0x1270
        // Flag 0x867: byte 268 (0x10C) bit 7, at SB1+0x137C
        // Flags 0x868-0x86E: byte 269 (0x10D) bits 0-6, at SB1+0x137D
        // SB1 sector 2 covers offsets 0x0F80-0x1EFF
        const sector2 = save.logicalSectors[2];
        if (!sector2) return 0;
        const sector2Base = sector2.physIdx * SECTOR_SIZE;
        // Offset within sector 2: 0x137C - 0x0F80 = 0x03FC
        const byte1 = save.sram[sector2Base + 0x03FC]; // badge 1 = bit 7
        const byte2 = save.sram[sector2Base + 0x03FD]; // badges 2-8 = bits 0-6
        let count = 0;
        if (byte1 & 0x80) count++;       // badge 1
        for (let i = 0; i < 7; i++) {
            if (byte2 & (1 << i)) count++; // badges 2-8
        }
        return count;
    }

    // ---- Write nature (change personality to get desired nature) ----
    function writeNature(save, partyIndex, newNature) {
        const mon = save.party[partyIndex];
        if (!mon) throw new Error('No Pokemon at party index ' + partyIndex);
        if (newNature < 0 || newNature >= 25) throw new Error('Invalid nature: ' + newNature);
        if (newNature === mon.nature) return save;

        const oldPersonality = mon.personality;
        const oldPerm = oldPersonality % 24;
        const oldNature = oldPersonality % 25;

        // Find delta = 24*k so (personality + delta) % 25 = newNature
        // and % 24 stays the same (delta is a multiple of 24)
        // Since 24 ≡ -1 (mod 25): 24*k ≡ -k (mod 25)
        // Need: -k ≡ newNature - oldNature (mod 25) → k = (oldNature - newNature + 25) % 25
        const k = (oldNature - newNature + 25) % 25;
        const delta = 24 * k;
        const newPersonality = (oldPersonality + delta) >>> 0; // u32

        // Preserve shiny status by adjusting shinyModifier bit
        const oid = mon.otId;
        const oldShinyVal = ((oid>>>16)^(oid&0xFFFF)^(oldPersonality>>>16)^(oldPersonality&0xFFFF));
        const newShinyVal = ((oid>>>16)^(oid&0xFFFF)^(newPersonality>>>16)^(newPersonality&0xFFFF));
        const oldNatShiny = oldShinyVal < 8 ? 1 : 0;
        const newNatShiny = newShinyVal < 8 ? 1 : 0;

        const rawView = new DataView(mon._raw.buffer, mon._raw.byteOffset, mon._raw.byteLength);
        if (oldNatShiny !== newNatShiny) {
            let word1E = u16(rawView, BM_HPLOST_WORD);
            word1E ^= (1 << 14); // flip shinyModifier
            w16(rawView, BM_HPLOST_WORD, word1E);
        }

        // Write new personality (little-endian u32)
        rawView.setUint32(BM_PERSONALITY, newPersonality, true);

        // Re-encrypt secure region with new personality
        const encrypted = new Uint8Array(BM_SECURE_SIZE);
        encrypted.set(mon._secure);
        xorSecure(encrypted, newPersonality, mon.otId);
        mon._raw.set(encrypted, BM_SECURE);

        // Update parsed properties
        mon.personality = newPersonality;
        mon.nature = newNature;
        mon.natureName = NATURE_NAMES[newNature] || '?';

        // Recalculate party stats with new nature modifiers
        const level = mon.level;
        const bs = mon.baseStats;
        const STAT_MAP = [
            { key:'attack',   ivKey:'attack',   off:PM_ATK, idx:0 },
            { key:'defense',  ivKey:'defense',  off:PM_DEF, idx:1 },
            { key:'speed',    ivKey:'speed',    off:PM_SPE, idx:2 },
            { key:'spAttack', ivKey:'spAttack', off:PM_SPA, idx:3 },
            { key:'spDefense',ivKey:'spDefense',off:PM_SPD, idx:4 },
        ];
        for (const sm of STAT_MAP) {
            const base = bs[sm.key];
            if (base != null) {
                const nmod = getNatureMod(newNature, sm.idx);
                const newVal = calcStat(base, mon.ivs[sm.ivKey], mon.evs[sm.key], level, nmod);
                w16(rawView, sm.off, newVal);
                mon.stats[sm.key] = newVal;
            }
        }

        // Copy modified raw back to SRAM
        save.sram.set(mon._raw, mon._sramOffset);

        // Recalculate sector checksum
        const sectorPhysIdx = Math.floor(mon._sramOffset / SECTOR_SIZE);
        const sectorBase = sectorPhysIdx * SECTOR_SIZE;
        const sectorData = save.sram.slice(sectorBase, sectorBase + SECTOR_DATA_SIZE);
        const newSectorChk = sectorChecksum(sectorData, SECTOR_DATA_SIZE);
        const sramView = new DataView(save.sram.buffer, save.sram.byteOffset, save.sram.byteLength);
        w16(sramView, sectorBase + FOOTER_CHKSUM, newSectorChk);

        return save;
    }

    return {
        parse, writeEVs, writeNature, readBadges,
        fromBase64, toBase64, evTotal, decodeGBAString,
        calcHP, calcStat, getNatureMod,
        NATURE_NAMES, NATURES,
    };
})();
