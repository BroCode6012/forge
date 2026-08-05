/**
 * Niche System — Content strategy layer
 *
 * Niches control BEHAVIOR:
 *   - Which MG types the AI can use (allowedMGs)
 *   - Footage search priorities (provider ordering)
 *   - Pacing defaults
 *   - Storytelling style cues
 *
 * Niches are SEPARATE from themes (visual system).
 * Each niche maps to a default theme, but the user or AI can override the theme independently.
 *
 * Flow:
 *   AI Director detects topic → pickNiche() → nicheId stored in scriptContext
 *   nicheId → drives MG selection, footage strategy, pacing
 *   themeId → drives colors, fonts, transitions, overlays (visual only)
 */

const { DISABLED_VIDEO_PROVIDER_KEYS, filterDisabledSources, sanitizeSourceHint } = require('../media/source-policy');

// ============================================================
// NICHE DEFINITIONS
// ============================================================

const NICHES = {
    // ────────────────────────────────────────────────────
    // EXPLAINER CATEGORY — educational / documentary content
    // ────────────────────────────────────────────────────

    'explainer.nature': {
        id: 'explainer.nature',
        _parent: 'explainer',
        name: 'Nature/Documentary',
        description: 'Nature, wildlife, environment, conservation',

        defaultTheme: 'minimal',

        shotStyle: 'Wide establishing shots of landscapes, slow-motion wildlife, macro nature details (insects, leaves, water droplets), aerial drone footage, golden hour and blue hour lighting.',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'mapChart', 'timeline',
            'focusWord', 'bulletList', 'statCounter', 'kineticText'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'slow',

        preferredMediaType: 'video',   // nature: wildlife, landscapes look better moving

        keywords: ['nature', 'wildlife', 'animal', 'environment', 'climate', 'earth',
                   'ocean', 'forest', 'plant', 'bird', 'ecosystem', 'conservation',
                   'species', 'habitat', 'marine', 'weather', 'geology'],

        searchPolicy: {
            contextTerms: ['nature', 'wildlife', 'natural'],
            avoidTerms: ['cartoon', 'illustration', 'clipart', 'drawing', 'animated'],
            fallbackKeywords: ['nature landscape', 'wildlife aerial', 'ocean waves', 'forest canopy'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'species-first',
            rules: [
                'Named animal/plant species → keyword = species name (e.g., "great white shark", "giant sequoia")',
                'Named location → keyword = location + natural feature (e.g., "Amazon rainforest canopy")',
                'Conservation topic → keyword = specific subject (e.g., "coral reef bleaching", "glacier retreat")',
                'Generic nature → keyword = specific visual subject, not abstract concepts (e.g., "wolf pack hunting" not "predator-prey dynamics")',
            ],
            examples: {
                good: ['"great white shark underwater"', '"Amazon rainforest aerial"', '"coral reef bleaching"', '"polar bear ice"'],
                bad: ['"ecosystem dynamics"', '"biodiversity loss"', '"environmental degradation"'],
            }
        },

        overlayPrefs: {
            v2Density: 'low',
            explainerDensity: 'low',
            maxOverlays: 2,
            minGapSec: 20,
            preferredTypes: ['v2'],
        }
    },

    'explainer.crime': {
        id: 'explainer.crime',
        _parent: 'explainer',
        name: 'True Crime/Mystery',
        description: 'Crime, mystery, thriller, investigation',

        defaultTheme: 'crime',

        shotStyle: 'Dark moody lighting, surveillance-style angles, slow zooms on evidence/documents, grainy archival photos, night scenes with streetlights, courtroom interiors, police tape close-ups.',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'timeline',
            'focusWord', 'mapChart', 'kineticText', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'image',   // crime: mugshots, evidence photos, news stills

        keywords: ['crime', 'murder', 'investigation', 'detective', 'mystery', 'thriller',
                   'police', 'fbi', 'criminal', 'suspect', 'evidence', 'court', 'trial',
                   'victim', 'disappear', 'serial', 'forensic', 'kidnap'],

        searchPolicy: {
            contextTerms: ['crime scene', 'investigation', 'documentary'],
            avoidTerms: ['cartoon', 'anime', 'game', 'movie trailer', 'fiction'],
            fallbackKeywords: ['police investigation', 'crime scene tape', 'courtroom interior', 'dark alley night'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Suspect/victim named → keyword = their name (e.g., "Ted Bundy mugshot", "Nicole Brown Simpson")',
                'Crime event → keyword = event descriptor (e.g., "OJ Simpson car chase", "Zodiac cipher letter")',
                'Location of crime → keyword = location + crime context (e.g., "Whitechapel alley night", "Alcatraz prison")',
                'Evidence/forensic → keyword = specific evidence type (e.g., "fingerprint analysis", "crime scene tape")',
                'Never use generic thriller imagery — always tie to the actual case/person discussed',
            ],
            examples: {
                good: ['"Ted Bundy courtroom"', '"crime scene tape night"', '"FBI raid mansion"', '"autopsy report document"'],
                bad: ['"dark mystery"', '"scary investigation"', '"creepy atmosphere"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'low',
            maxOverlays: 4,
            minGapSec: 10,
            preferredTypes: ['v2'],
        }
    },

    'explainer.business': {
        id: 'explainer.business',
        _parent: 'explainer',
        name: 'Business/Corporate',
        description: 'Business, finance, economics, corporate',

        defaultTheme: 'standard',

        shotStyle: 'Clean corporate environments, glass office buildings, stock tickers, boardroom meetings, city skylines at dusk, data dashboards on screens, professional handshakes.',

        allowedMGs: [
            'barChart', 'donutChart', 'timeline', 'statCounter', 'bulletList',
            'comparisonCard', 'lowerThird', 'progressBar', 'headline', 'kineticText'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // business: real product footage (video) + generic office/charts (stock)

        // Keywords are scored as anchors. Generic single-words like "market", "stock",
        // "economy" matched too liberally on geopolitical scripts ("global stock market",
        // "world economy") — they're now multi-word phrases that demand a clearly
        // business context. Strong identity terms (ipo, earnings, merger, ceo, quarterly)
        // remain single-word because they only appear in real business content.
        keywords: ['corporate', 'startup', 'company earnings', 'company stock', 'stock price',
                   'stock split', 'stock market crash', 'stock market rally', 'bull market', 'bear market',
                   'profit margin', 'revenue growth', 'venture capital', 'private equity', 'hedge fund',
                   'wall street', 'boardroom', 'trading floor', 'quarterly earnings', 'annual report',
                   'ceo', 'cfo', 'cto', 'ipo', 'merger', 'acquisition', 'shareholder',
                   'startup funding', 'business model', 'market cap', 'balance sheet',
                   'consumer brand', 'product launch', 'corporate strategy', 'fintech',
                   'automotive market', 'car market', 'auto market', 'vehicle market',
                   'car sales', 'vehicle sales', 'top-selling car', 'best-selling car',
                   'new car registrations', 'market share', 'dealer network', 'dealership',
                   'automotive exporter', 'car manufacturer', 'vehicle manufacturer'],

        searchPolicy: {
            contextTerms: ['business', 'corporate', 'finance'],
            avoidTerms: ['cartoon', 'clipart', 'illustration', 'meme'],
            fallbackKeywords: ['corporate office', 'stock market graph', 'business meeting', 'city skyline'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Company/person named → keyword = entity name + context (e.g., "Elon Musk Tesla", "Warren Buffett portrait")',
                'Financial data → keyword = specific metric visual (e.g., "stock market crash graph", "GDP growth chart")',
                'Corporate event → keyword = event name (e.g., "Apple WWDC keynote", "IPO bell ceremony")',
                'Generic business → keyword = concrete setting (e.g., "trading floor monitors", "boardroom meeting")',
            ],
            examples: {
                good: ['"Warren Buffett portrait"', '"stock market crash 2008"', '"Wall Street trading floor"', '"corporate merger handshake"'],
                bad: ['"business strategy"', '"economic impact"', '"financial situation"'],
            }
        },

        overlayPrefs: {
            v2Density: 'high',
            explainerDensity: 'medium',
            maxOverlays: 6,
            minGapSec: 8,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    'explainer.luxury': {
        id: 'explainer.luxury',
        _parent: 'explainer',
        name: 'Luxury/Fashion',
        description: 'High-end, fashion, lifestyle, premium',

        defaultTheme: 'history',

        shotStyle: 'Macro photography with shallow depth of field (bokeh), slow smooth panning, elegant warm lighting, gold/black tones, glamorous interiors, fashion runway angles, product hero shots.',

        allowedMGs: [
            'headline', 'lowerThird', 'focusWord', 'kineticText', 'callout',
            'statCounter', 'donutChart', 'rankingList', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'slow',

        preferredMediaType: 'video',   // luxury: cars, watches, lifestyle in motion

        keywords: ['luxury', 'fashion', 'beauty', 'style', 'elegant', 'premium',
                   'designer', 'haute', 'couture', 'wedding', 'jewelry', 'art',
                   'luxury brand', 'designer brand', 'premium brand', 'exclusive',
                   'boutique', 'lifestyle'],

        searchPolicy: {
            contextTerms: ['luxury', 'premium', 'elegant'],
            avoidTerms: ['cheap', 'cartoon', 'clipart', 'diy', 'budget'],
            fallbackKeywords: ['luxury interior', 'fashion runway', 'gold texture close up', 'elegant architecture'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'brand-first',
            rules: [
                'Brand/designer named → keyword = brand name + product (e.g., "Louis Vuitton runway", "Rolex Submariner")',
                'Celebrity/personality → keyword = their name (e.g., "Kim Kardashian Met Gala", "David Beckham")',
                'Luxury location → keyword = specific place (e.g., "Monaco yacht harbor", "Dubai Burj Khalifa")',
                'Generic luxury → keyword = specific aspirational visual (e.g., "champagne crystal glass", "sports car showroom")',
                'Avoid generic "luxury" or "expensive" — show, don\'t tell',
            ],
            examples: {
                good: ['"Rolex Submariner close up"', '"Monaco Grand Prix yacht"', '"Chanel runway model"', '"penthouse skyline view"'],
                bad: ['"luxury lifestyle"', '"expensive things"', '"rich person"'],
            }
        },

        overlayPrefs: {
            v2Density: 'low',
            explainerDensity: 'medium',
            maxOverlays: 3,
            minGapSec: 15,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    'explainer.sport': {
        id: 'explainer.sport',
        _parent: 'explainer',
        name: 'Sports/Action',
        description: 'Sports, competition, athletics, action',

        defaultTheme: 'modern',

        shotStyle: 'Fast tracking shots, dynamic wide angles, high contrast, slow-motion replays, stadium crowd shots, close-ups of athletes in action, overhead tactical views.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'focusWord', 'typewriter', 'kineticText'
        ],

        footagePriority: {
            video: ['reddit', 'youtube', 'storyblocks'],
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'fast',

        preferredMediaType: 'video',   // sport: action footage needs movement

        keywords: ['sport', 'game', 'team', 'player', 'athlete', 'competition',
                   'championship', 'match', 'race', 'fight', 'extreme', 'action',
                   'goal', 'score', 'tournament', 'league', 'coach', 'season'],

        searchPolicy: {
            contextTerms: ['sports', 'athletic', 'competition'],
            avoidTerms: ['cartoon', 'anime', 'game screenshot', 'esports'],
            fallbackKeywords: ['stadium crowd', 'athletic competition', 'sports action', 'running track'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'athlete-first',
            rules: [
                'Athlete named → keyword = athlete name + sport context (e.g., "LeBron James dunk", "Messi World Cup")',
                'Team named → keyword = team name + action (e.g., "Lakers championship", "Manchester United")',
                'Sporting event → keyword = event name (e.g., "Super Bowl halftime", "Olympics 100m final")',
                'Generic sports → keyword = specific sport action (e.g., "soccer penalty kick", "basketball slam dunk")',
                'Never use abstract terms — sports need action and energy in the keyword',
            ],
            examples: {
                good: ['"LeBron James dunk"', '"World Cup penalty kick"', '"Formula 1 pit stop"', '"boxing knockout ring"'],
                bad: ['"sports competition"', '"athletic achievement"', '"team spirit"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'low',
            maxOverlays: 4,
            minGapSec: 10,
            preferredTypes: ['v2'],
        }
    },

    explainer: {
        id: 'explainer',
        name: 'Explainer/Documentary (Generic)',
        description: 'Catch-all for educational documentary content. Sub-niches (explainer.nature, explainer.crime, etc.) provide more specific behavior.',

        defaultTheme: 'modern',

        shotStyle: 'Clean well-lit B-roll, cross-section diagrams, infographics, aerial drone shots, macro close-ups of materials/processes, laboratory interiors, blueprint overlays, factory/workshop footage, before/after comparisons. NO presenters or talking heads — faceless B-roll only.',

        // RICH visual treatment — all MG types available
        allowedMGs: [
            'headline', 'lowerThird', 'bulletList', 'statCounter', 'barChart', 'donutChart',
            'timeline', 'comparisonCard', 'focusWord', 'callout', 'explainer', 'progressBar',
            'rankingList', 'kineticText', 'mapChart', 'typewriter'
        ],

        footagePriority: {
            video: ['storyblocks', 'youtube', 'reddit'],    // stock FIRST for clean B-roll
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // explainer: diagrams/images + process video

        keywords: ['explain', 'how', 'works', 'build', 'construction', 'engineer', 'engineering',
                   'architecture', 'architect', 'design', 'structure', 'material', 'insulation',
                   'energy', 'solar', 'panel', 'dome', 'concrete', 'steel', 'frame', 'wall',
                   'foundation', 'roof', 'infrastructure', 'bridge', 'tunnel', 'pipeline',
                   'process', 'method', 'technique', 'system', 'mechanism', 'principle',
                   'science', 'physics', 'chemistry', 'biology', 'anatomy', 'molecule',
                   'experiment', 'laboratory', 'research', 'study', 'diagram', 'cross section',
                   'sustainable', 'renewable', 'efficiency', 'thermal', 'hydraulic', 'electric',
                   'manufacture', 'factory', 'assembly', 'prototype', 'innovation', 'invention',
                   'education', 'tutorial', 'lesson', 'course', 'academic', 'university',
                   'monolithic', 'aerodynamic', 'geothermal', 'photovoltaic', 'composite'],

        searchPolicy: {
            contextTerms: ['explained', 'how it works', 'documentary'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'toy', 'presenter', 'talking head', 'vlog'],
            fallbackKeywords: ['engineering cross section', 'construction process', 'science diagram', 'factory interior'],
            entityBoost: true,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'concept-visual',
            rules: [
                'Specific structure/material → keyword = structure + detail (e.g., "concrete dome cross section", "fiberglass insulation wall")',
                'Scientific concept → keyword = visual representation (e.g., "DNA double helix", "thermal imaging house")',
                'Named person/inventor → keyword = their name + invention (e.g., "Wallace Neff architect", "Nikola Tesla coil")',
                'Process/mechanism → keyword = concrete step visual (e.g., "spray foam insulation wall", "solar panel installation")',
                'Abstract principle → keyword = tangible visual (e.g., "wind tunnel aerodynamics" not "energy efficiency concept")',
                'Prefer CLEAN B-roll: close-ups of materials, cross-sections, aerial views of structures — NO people/presenters',
            ],
            examples: {
                good: ['"concrete dome cross section"', '"fiberglass insulation wall frame"', '"solar panel rooftop aerial"', '"steel bridge construction"'],
                bad: ['"educational concept"', '"how things work"', '"technology explanation"', '"scientific method"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 6,
            minGapSec: 8,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    // ────────────────────────────────────────────────────
    // NEWS CATEGORY — breaking / current events
    // ────────────────────────────────────────────────────

    news: {
        id: 'news',
        name: 'News/Current Events',
        description: 'Breaking news, current events, journalism — footage-driven, minimal graphics',

        defaultTheme: 'modern',

        shotStyle: 'Press conference angles, newsroom-style framing, split-screen layouts, on-location establishing shots, document/headline close-ups, crowd footage, official building exteriors.',

        // NEWS = footage-driven. Only essential MGs: lower thirds, headlines, maps
        allowedMGs: [
            'headline', 'lowerThird', 'mapChart',
            'focusWord', 'statCounter', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'fast',

        preferredMediaType: 'video',   // news: real news footage from DW, RT, Al Jazeera, France24

        keywords: ['news', 'politics', 'government', 'election', 'president', 'congress',
                   'war', 'conflict', 'crisis', 'breaking', 'report', 'journalist',
                   'scandal', 'policy', 'law', 'legislation', 'vote'],

        searchPolicy: {
            contextTerms: ['news', 'press', 'report'],
            avoidTerms: ['cartoon', 'meme', 'satire', 'parody'],
            fallbackKeywords: ['news broadcast', 'press conference', 'government building', 'world map'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Politician/leader named → keyword = their name + context (e.g., "Biden press conference", "Putin Kremlin")',
                'News event → keyword = specific event descriptor (e.g., "Capitol riot January 6", "earthquake Turkey 2023")',
                'Organization/agency → keyword = org name + visual (e.g., "FBI headquarters", "United Nations assembly")',
                'Policy/legislation → keyword = related visual (e.g., "Supreme Court building", "protest march signs")',
                'Always use real names and dates — news needs specificity to find the right footage',
            ],
            examples: {
                good: ['"Biden State of the Union"', '"Ukraine frontline 2024"', '"Congress vote floor"', '"wildfire California aerial"'],
                bad: ['"political situation"', '"breaking news event"', '"government decision"'],
            }
        },

        overlayPrefs: {
            v2Density: 'high',
            explainerDensity: 'low',
            maxOverlays: 6,
            minGapSec: 8,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    // ────────────────────────────────────────────────────
    // NEWS SUB-NICHES — inherit from 'news', override specific fields
    // Format: 'news.subNiche' — resolved by getNiche() via deep merge
    // ────────────────────────────────────────────────────
    'news.politics': {
        id: 'news.politics',
        _parent: 'news',
        name: 'News / Politics & Geopolitics',
        description: 'Political news, elections, government, geopolitics, diplomacy, sanctions — footage-driven',

        shotStyle: 'Press conferences, parliament/congress floor votes, diplomatic handshakes, protest marches, government building exteriors, official portraits, world leader summits, embassy exteriors.',

        // Footage-driven: only essential overlays
        allowedMGs: [
            'headline', 'lowerThird', 'mapChart',
            'focusWord', 'statCounter', 'typewriter'
        ],

        mgRules: [
            'LOCATION RULE: Every time a location/place/country/city/region/strait/base is mentioned → MUST use lowerThird with the location name as text. Locations are critical context in political news.',
            'TIME RULE: Every time a specific time/date/hour is mentioned (e.g. "5:27 local time", "March 15", "Tuesday") → MUST use typewriter with the time/date as text. Timestamps anchor the news narrative.',
        ],

        // YouTube first. Political news is EVENT footage — a specific speech, a
        // specific hearing, a specific press conference. Stock libraries have no
        // clip of the thing the script is actually about; YouTube does.
        //
        // This used to be stock-first with `scoutDemote: ['youtube']`, which was
        // a triple lock: YouTube ranked last here, forced to the back of the
        // scout's empirical order even when it scored highest, AND hidden from
        // the Visual Planner so the AI could not pick it. The stated reason was
        // that broadcast packages fail the raw-footage vision gate (anchor
        // heads, network watermarks). That was a real observation, but the cure
        // was a permanent ban that no evidence could lift.
        //
        // It is now handled where it belongs, by two live mechanisms instead of
        // a static table: the Storyboard Scout localises the clean 5–15s window
        // inside a long YouTube video, and `media/provider-scoreboard.js` sinks
        // any provider that keeps losing IN THIS BUILD. If YouTube really is
        // the wrong source for a given video, the run discovers that in three
        // scenes and re-ranks itself — per topic, from data.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        preferredMediaType: 'video',

        keywords: ['politics', 'government', 'election', 'president', 'congress', 'senate',
                   'parliament', 'prime minister', 'diplomat', 'sanctions', 'policy', 'legislation',
                   'vote', 'campaign', 'geopolitics', 'summit', 'treaty', 'embassy', 'UN',
                   'nato', 'G7', 'G20', 'tariff', 'trade war', 'executive order'],

        searchPolicy: {
            contextTerms: ['politics', 'government', 'official'],
            avoidTerms: ['cartoon', 'meme', 'satire', 'parody', 'game'],
            fallbackKeywords: ['press conference podium', 'government building capitol', 'world leaders summit', 'parliament session'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Politician/leader named → keyword = their name + context (e.g., "Biden press conference", "Putin Kremlin")',
                'Government body → keyword = building/chamber (e.g., "US Capitol building", "European Parliament")',
                'Geopolitical event → keyword = specific event (e.g., "G7 summit Italy", "UN General Assembly")',
                'Policy/legislation → keyword = related visual (e.g., "Supreme Court building", "protest march signs")',
                'Election → keyword = campaign event (e.g., "Trump rally", "ballot counting")',
                'Always use real names and specific institutions — political news demands precision',
            ],
            examples: {
                good: ['"Biden State of the Union"', '"EU sanctions Russia"', '"Congress vote floor"', '"NATO summit Brussels"'],
                bad: ['"political situation"', '"government decision"', '"world leaders meeting"'],
            }
        },

        classBias: {
            'actor-event':    { preferredSource: 'youtube' },
            'location-event': { preferredSource: 'youtube' },
            'object-scene':   { preferredSource: 'youtube' },
        },
    },

    'news.celebrity': {
        id: 'news.celebrity',
        _parent: 'news',
        name: 'News / Celebrity & Entertainment',
        description: 'Celebrity news, gossip, entertainment industry, sports celebrities, pop culture — footage-driven',

        shotStyle: 'Red carpet photos, paparazzi shots, award ceremony stages, studio interviews, social media screenshots, magazine covers, concert/event footage, sports press conferences.',

        // Celebrity = mostly photos/clips, light MGs
        allowedMGs: [
            'headline', 'lowerThird', 'focusWord',
            'typewriter'
        ],

        // YouTube first. Celebrity coverage IS video: red carpets, interviews,
        // award stages, press junkets. Reddit stays second (it mirrors a lot of
        // the same clips and is fast), stock last — it has models, not people.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        preferredMediaType: 'video',

        keywords: ['celebrity', 'actor', 'actress', 'singer', 'rapper', 'musician',
                   'athlete', 'star', 'famous', 'hollywood', 'grammy', 'oscar', 'emmy',
                   'red carpet', 'paparazzi', 'gossip', 'scandal', 'divorce', 'dating',
                   'album', 'tour', 'box office', 'award', 'nomination', 'instagram',
                   'tiktok', 'viral', 'nba', 'nfl', 'ufc', 'fifa', 'champion'],

        searchPolicy: {
            contextTerms: ['celebrity', 'star', 'entertainment'],
            avoidTerms: ['cartoon', 'fan art', 'anime', 'cosplay', 'fictional'],
            fallbackKeywords: ['red carpet celebrity event', 'Hollywood Walk of Fame', 'award ceremony stage', 'paparazzi photo'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Celebrity named → keyword = their name + "photo" or event (e.g., "Taylor Swift Grammy 2024", "LeBron James press conference")',
                'Event/show → keyword = event name + visual (e.g., "Oscar ceremony stage", "Super Bowl halftime")',
                'Scandal/gossip → keyword = person name + context (e.g., "Kanye West interview", "Britney Spears conservatorship")',
                'Movie/album → keyword = title + release (e.g., "Oppenheimer movie poster", "Beyonce Renaissance tour")',
                'ALWAYS use the celebrity\'s real name — fans search by name',
            ],
            examples: {
                good: ['"Taylor Swift Eras Tour"', '"LeBron James Lakers"', '"Oscar Best Picture 2024"', '"Drake album cover"'],
                bad: ['"famous person event"', '"celebrity news"', '"entertainment update"'],
            }
        },
    },

    'news.economy': {
        id: 'news.economy',
        _parent: 'news',
        name: 'News / Economy & Markets',
        description: 'Economic news, stock markets, trade, inflation, business news, central banks — footage-driven',

        shotStyle: 'Stock market tickers, trading floor footage, central bank buildings, currency notes close-ups, oil rigs/pipelines, shipping containers, Wall Street exteriors, chart/graph overlays, factory/warehouse interiors.',

        // Economy news: a bit more data viz than other news, but still light
        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'mapChart',
            'focusWord', 'typewriter'
        ],

        // YouTube first. Economy news is the closest call in this family —
        // trading floors and currency close-ups are genuinely well covered by
        // stock — but the SPECIFIC event (this crash, this rate decision, this
        // central banker at this podium) is only on YouTube. Stock stays in the
        // ladder for generic b-roll, and the live scoreboard will lift it back
        // up on any build where it actually wins.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        preferredMediaType: 'video',

        keywords: ['economy', 'market', 'stock', 'inflation', 'gdp', 'recession',
                   'federal reserve', 'interest rate', 'wall street', 'nasdaq', 'dow jones',
                   'oil price', 'trade', 'tariff', 'export', 'import', 'supply chain',
                   'central bank', 'currency', 'dollar', 'euro', 'bitcoin', 'crypto',
                   'debt', 'deficit', 'unemployment', 'jobs report', 'earnings'],

        searchPolicy: {
            contextTerms: ['economy', 'market', 'financial'],
            avoidTerms: ['cartoon', 'meme', 'game', 'fiction', 'crypto scam'],
            fallbackKeywords: ['stock market trading floor', 'Wall Street New York', 'oil refinery aerial', 'shipping port containers'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'topic-visual',
            rules: [
                'Company named → keyword = company name + visual (e.g., "Tesla factory", "Apple headquarters Cupertino")',
                'Market/index → keyword = trading visual (e.g., "stock market trading floor", "NASDAQ screen")',
                'Commodity → keyword = commodity visual (e.g., "oil refinery aerial", "gold bars vault")',
                'Central bank/policy → keyword = institution (e.g., "Federal Reserve building", "ECB Frankfurt")',
                'Economic data → keyword = related visual (e.g., "factory assembly line", "shipping containers port")',
                'Use specific company names and financial institutions — generic "economy" returns nothing useful',
            ],
            examples: {
                good: ['"Tesla Gigafactory"', '"Federal Reserve building"', '"oil pipeline Saudi Arabia"', '"Wall Street bull statue"'],
                bad: ['"economy situation"', '"financial market"', '"business news"'],
            }
        },
    },

    'news.military': {
        id: 'news.military',
        _parent: 'news',
        name: 'News / Military & Geopolitics',
        description: 'Military news, war, geopolitics, global conflicts, defense, arms deals',

        defaultTheme: 'crime',

        shotStyle: 'Satellite imagery, military vehicle footage, map animations with troop movements, night-vision style shots, naval fleet aerials, press conferences, border checkpoints, destroyed infrastructure.',

        // Military: maps + headlines, footage-driven
        allowedMGs: [
            'headline', 'lowerThird', 'mapChart', 'statCounter',
            'focusWord', 'typewriter'
        ],

        mgRules: [
            'LOCATION RULE: Every time a location/place/country/city/region/strait/base/port is mentioned → MUST use lowerThird with the location name as text. Locations are critical context in military news.',
            'TIME RULE: Every time a specific time/date/hour is mentioned (e.g. "5:27 local time", "March 15", "0600 hours") → MUST use typewriter with the time/date as text. Timestamps anchor the news narrative.',
        ],

        // YouTube first — see the note on news.politics. Military news is the
        // strongest case of all: stock has generic soldiers and generic jets,
        // but the specific strike, the specific fleet, the specific border
        // incident only exists as real footage.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'video',

        keywords: ['military', 'army', 'navy', 'naval', 'war', 'conflict', 'geopolitics', 'geopolitical',
                   'troops', 'missile', 'weapon', 'defense', 'nato', 'invasion', 'border',
                   'sanctions', 'nuclear', 'submarine', 'drone', 'airforce', 'tank',
                   'soldier', 'regiment', 'alliance', 'territory', 'occupation',
                   'airstrike', 'strike', 'combat', 'radar', 'fighter', 'bomber',
                   'warship', 'artillery', 'ammunition', 'air force', 'battleground',
                   'squadron', 'fleet', 'pentagon', 'armed forces', 'warfare',
                   'carrier', 'sailor', 'deployment', 'propulsion', 'sabotage',
                   'arson', 'admiral', 'destroyer', 'frigate', 'cruiser',
                   'reconnaissance', 'amphibious', 'battleship'],

        searchPolicy: {
            contextTerms: ['military', 'conflict', 'geopolitical'],
            avoidTerms: ['cartoon', 'game', 'movie', 'fiction', 'call of duty', 'anime'],
            fallbackKeywords: ['military operation', 'world map geopolitics', 'naval fleet ocean', 'satellite aerial view'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Military leader/figure → keyword = their name + context (e.g., "General Patton portrait", "Zelensky address")',
                'Specific conflict → keyword = conflict name + visual (e.g., "Ukraine frontline trench", "Syria Aleppo ruins")',
                'Military hardware → keyword = specific equipment (e.g., "F-35 fighter jet", "aircraft carrier deck")',
                'Strategic location → keyword = place + military context (e.g., "Taiwan Strait naval", "NATO summit Brussels")',
                'Use military terminology — accurate equipment names and conflict references',
            ],
            examples: {
                good: ['"F-35 fighter jet takeoff"', '"Ukraine trench warfare"', '"aircraft carrier deck"', '"NATO summit leaders"'],
                bad: ['"military operation"', '"war zone"', '"conflict area"'],
            }
        },

        classBias: {
            'actor-event':    { preferredSource: 'youtube' },
            'location-event': { preferredSource: 'youtube' },
            'object-scene':   { preferredSource: 'youtube' },
            'data-claim':     { allowedMGs: ['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'statCounter', 'dataBar', 'focusWord'], allowedTemplates: ['statCard', 'comparisonCard', 'factCard'] },
        },
    },

    'news.tech': {
        id: 'news.tech',
        _parent: 'news',
        name: 'News / Tech & Science',
        description: 'Technology news, AI, cybersecurity, product launches, science breakthroughs',

        defaultTheme: 'modern',

        shotStyle: 'Neon-lit close-ups of screens and hardware, dark rooms with monitor glow, data visualizations, smooth tracking shots of server rooms and labs, aerial shots of tech campuses, product launch stages.',

        // Tech NEWS: product launches, breakthroughs, incidents — footage-driven like all news
        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'focusWord',
            'typewriter'
        ],

        // YouTube first. Tech news is launch keynotes, teardowns, demos and
        // conference footage — all natively YouTube. Stock gives you a generic
        // server room when the script is about one specific product.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'fast',

        preferredMediaType: 'video',

        // ONLY tech NEWS keywords — not explainer/how-things-work (those go to 'explainer' niche)
        keywords: ['tech', 'ai', 'cyber', 'hack', 'digital', 'code', 'robot',
                   'virtual', 'computer', 'software', 'data', 'algorithm', 'startup',
                   'app', 'silicon', 'processor', 'cloud', 'blockchain', 'machine learning',
                   'launch', 'release', 'update', 'patch', 'vulnerability', 'breach'],

        searchPolicy: {
            contextTerms: ['technology', 'digital', 'futuristic'],
            avoidTerms: ['cartoon', 'anime', 'illustration', 'clipart', 'drawing'],
            fallbackKeywords: ['technology background', 'digital abstract', 'circuit board close up', 'server room'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'product-first',
            rules: [
                'Product/tool name mentioned → keyword = product name (e.g., "ChatGPT interface", "iPhone 16 Pro")',
                'Company mentioned → keyword = company + context (e.g., "NVIDIA headquarters", "Apple keynote")',
                'Abstract concept → keyword = concrete visual representation (e.g., "server rack data center" not "cloud computing")',
                'Never use jargon-only keywords — always include a visual anchor word',
            ],
            examples: {
                good: ['"ChatGPT interface screenshot"', '"NVIDIA GPU chip"', '"server room rows"', '"robot arm factory"'],
                bad: ['"artificial intelligence"', '"machine learning algorithm"', '"cloud-native architecture"'],
            }
        },
    },

    'explainer.history': {
        id: 'explainer.history',
        _parent: 'explainer',
        name: 'History/Documentary',
        description: 'History, historical events, civilizations, biography',

        defaultTheme: 'history',

        shotStyle: 'Slow pans across historical photos and paintings, sepia/desaturated tones, map animations, monument establishing shots, museum artifact close-ups, archival film grain.',

        allowedMGs: [
            'headline', 'lowerThird', 'timeline', 'mapChart', 'callout',
            'focusWord', 'bulletList', 'statCounter', 'kineticText', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'slow',

        preferredMediaType: 'image',   // history: historical photos, paintings, maps

        keywords: ['history', 'ancient', 'medieval', 'century', 'empire', 'civilization',
                   'dynasty', 'revolution', 'colonial', 'archaeological', 'historic',
                   'era', 'kingdom', 'battle', 'monument', 'artifact', 'biography',
                   'golden age', 'hollywood', 'oscar', 'academy award', 'autobiography',
                   'segregation', 'civil rights', 'racism', 'decades ago', 'archival'],

        searchPolicy: {
            contextTerms: ['historical', 'vintage', 'archive'],
            avoidTerms: ['cartoon', 'anime', 'game', 'fiction'],
            fallbackKeywords: ['historical documentary', 'ancient ruins', 'old photograph archive', 'museum artifact'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Historical person mentioned → keyword = their name (e.g., "Sammy Davis Jr.", "Cleopatra portrait")',
                'Historical event → keyword = event + era (e.g., "D-Day Normandy 1944", "Boston Tea Party")',
                'Era/period discussed → keyword = iconic visual of that era (e.g., "Victorian London street", "1920s jazz club")',
                'Historical place → keyword = place name + period (e.g., "ancient Rome Forum", "medieval castle")',
                'No screenplay descriptions — keyword is for SEARCH, not shot direction',
            ],
            examples: {
                good: ['"Sammy Davis Jr."', '"D-Day Normandy beach"', '"Victorian London street"', '"Egyptian pyramids Giza"'],
                bad: ['"dramatic historical moment"', '"ancient civilization glory"', '"slow pan across old battlefield"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'medium',
            maxOverlays: 4,
            minGapSec: 12,
            preferredTypes: ['v2', 'explainer'],
        },

        classBias: {
            'actor-event':    { preferredSource: 'web-image', allowedTemplates: ['personIntro', 'factCard'] },
            'location-event': { preferredSource: 'web-image' },
            'object-scene':   { preferredSource: 'web-image' },
        },
    },

    'explainer.motivation': {
        id: 'explainer.motivation',
        _parent: 'explainer',
        name: 'Motivation/Self-Help',
        description: 'Motivational, self-improvement, inspirational, mindset',

        defaultTheme: 'minimal',

        shotStyle: 'Cinematic wide shots of people in motion (running, climbing, working out), sunrise/sunset golden hour, silhouettes, dramatic clouds, slow-motion determination shots, urban hustle scenes.',

        allowedMGs: [
            'focusWord', 'kineticText', 'headline', 'statCounter', 'callout',
            'bulletList', 'progressBar', 'lowerThird', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'video',   // motivation: people, nature, activity clips

        keywords: ['motivation', 'inspire', 'success', 'mindset', 'discipline', 'grind',
                   'hustle', 'self-improvement', 'habit', 'productivity', 'growth',
                   'confidence', 'resilience', 'goal', 'dream', 'overcome', 'achieve'],

        searchPolicy: {
            contextTerms: ['motivational', 'inspirational', 'cinematic'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'comedy'],
            fallbackKeywords: ['sunrise mountain top', 'person running cinematic', 'city skyline golden hour', 'ocean waves dramatic'],
            entityBoost: false,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'visual-metaphor',
            rules: [
                'Inspirational figure → keyword = person + achievement (e.g., "David Goggins running", "Steve Jobs Apple")',
                'Abstract concept (discipline, hustle) → keyword = visual metaphor (e.g., "sunrise mountain summit", "runner finish line")',
                'Success story → keyword = concrete achievement visual (e.g., "marathon finish line", "graduation ceremony")',
                'Motivational quote context → keyword = powerful imagery (e.g., "ocean storm waves", "man climbing mountain")',
                'Always pick visuals with emotional energy — avoid static/boring imagery',
            ],
            examples: {
                good: ['"sunrise mountain summit"', '"runner crossing finish line"', '"ocean storm waves"', '"person meditating sunrise"'],
                bad: ['"motivation concept"', '"success mindset"', '"self improvement"'],
            }
        },

        overlayPrefs: {
            v2Density: 'low',
            explainerDensity: 'low',
            maxOverlays: 2,
            minGapSec: 20,
            preferredTypes: ['v2'],
        }
    },

    'explainer.food': {
        id: 'explainer.food',
        _parent: 'explainer',
        name: 'Food/Health',
        description: 'Food, nutrition, health, diet, cooking, wellness',

        defaultTheme: 'minimal',

        shotStyle: 'Close-up food photography with shallow depth of field, kitchen prep shots, ingredient flat-lays, grocery store aisles, farm-to-table scenes, vibrant produce macro shots, scientific diagrams of nutrition.',

        allowedMGs: [
            'headline', 'bulletList', 'statCounter', 'callout', 'focusWord',
            'comparisonCard', 'rankingList', 'lowerThird', 'barChart', 'explainer', 'kineticText'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // food: product shots (image) + cooking/prep (video)

        keywords: ['food', 'recipe', 'cook', 'nutrition', 'diet', 'health', 'superfood',
                   'ingredient', 'vitamin', 'organic', 'vegan', 'meal', 'restaurant',
                   'calorie', 'protein', 'supplement', 'wellness', 'detox', 'gut',
                   'kitchen', 'grocery', 'fda', 'contamination', 'pesticide'],

        searchPolicy: {
            contextTerms: ['food', 'nutrition', 'health'],
            avoidTerms: ['cartoon', 'clipart', 'illustration', 'anime', 'game'],
            fallbackKeywords: ['fresh food kitchen', 'healthy meal preparation', 'organic produce close up', 'nutrition science'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'ingredient-first',
            rules: [
                'Specific food/ingredient named → keyword = food item (e.g., "avocado close up", "salmon sushi platter")',
                'Brand/restaurant named → keyword = brand + food context (e.g., "McDonalds Big Mac", "Whole Foods organic aisle")',
                'Health condition/nutrient → keyword = visual representation (e.g., "vitamin supplement pills", "gut bacteria diagram")',
                'Cooking process → keyword = specific action (e.g., "chef slicing vegetables", "boiling pasta pot")',
                'Food should look appetizing — prefer close-up, well-lit food photography keywords',
            ],
            examples: {
                good: ['"avocado toast close up"', '"sushi platter Japanese"', '"farmer market produce"', '"chef knife slicing"'],
                bad: ['"healthy food"', '"nutrition concept"', '"diet plan"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 5,
            minGapSec: 10,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    'explainer.diy': {
        id: 'explainer.diy',
        _parent: 'explainer',
        name: 'DIY/Lifehacks',
        description: 'Do-it-yourself, life hacks, home improvement, tips & tricks',

        defaultTheme: 'standard',

        shotStyle: 'Hands-on POV shots, before/after reveals, step-by-step close-ups, workshop/garage/kitchen settings, tool close-ups, bright well-lit practical demonstrations, split-screen comparisons.',

        allowedMGs: [
            'headline', 'bulletList', 'callout', 'focusWord', 'statCounter',
            'comparisonCard', 'progressBar', 'lowerThird', 'rankingList', 'explainer', 'kineticText'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'video',   // diy: demos need to show process in motion

        keywords: ['diy', 'hack', 'trick', 'tip', 'homemade', 'craft', 'repair',
                   'fix', 'build', 'project', 'woodworking', 'cleaning', 'organize',
                   'renovation', 'garden', 'tool', 'home improvement', 'upcycle',
                   'tutorial', 'step by step', 'before after', 'life hack',
                   'repairable', 'rebuildable', 'durable', 'durability',
                   'built to last', 'long-lasting', 'buy it for life',
                   'planned obsolescence', 'appliance', 'hand tool', 'workshop'],

        searchPolicy: {
            contextTerms: ['DIY', 'how to', 'tutorial'],
            avoidTerms: ['cartoon', 'clipart', 'anime', 'game', 'illustration'],
            fallbackKeywords: ['DIY workshop tools', 'home improvement project', 'hands on craft', 'before after renovation'],
            entityBoost: false,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'process-first',
            rules: [
                'Specific tool/material → keyword = tool/material name (e.g., "power drill wood", "paint roller wall")',
                'Before/after → keyword = specific transformation (e.g., "kitchen renovation before", "rusty furniture restored")',
                'Step in a process → keyword = hands-on action (e.g., "measuring tape cutting wood", "soldering circuit board")',
                'Generic hack/tip → keyword = concrete visual of the tip in action (e.g., "baking soda cleaning sink" not "cleaning hack")',
                'Show hands doing things — DIY is about process, not finished products alone',
            ],
            examples: {
                good: ['"power drill wood plank"', '"paint roller white wall"', '"garden raised bed building"', '"hands sewing fabric"'],
                bad: ['"DIY project"', '"life hack idea"', '"home improvement"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 5,
            minGapSec: 10,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    // ────────────────────────────────────────────────────
    // NEW EXPLAINER SUB-NICHES
    // ────────────────────────────────────────────────────

    'explainer.military': {
        id: 'explainer.military',
        _parent: 'explainer',
        name: 'Military & Geopolitical Explainer',
        description: 'Armed-forces & warfare analysis — weapons technology, defense strategy, battles, military hardware/operations, documentary. NOT general geopolitics/trade (that is the politics niche), NOT breaking news',

        defaultTheme: 'crime',

        shotStyle: 'Archival military footage, aircraft/tank/ship close-ups, drone footage, satellite imagery, geopolitical maps, war memorial shots, battlefield aerials, museum weapon exhibits, historical command maps, documentary-style infographics, flags and diplomacy shots.',

        allowedMGs: [
            'headline', 'lowerThird', 'mapChart', 'timeline', 'statCounter',
            'focusWord', 'callout', 'bulletList', 'kineticText', 'typewriter',
            'barChart', 'comparisonCard'
        ],

        // YouTube first — same reasoning as news.military (see news.politics for
        // the full note). This niche carried the identical stock-first +
        // scoutDemote lock and had the identical problem.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'moderate',
        preferredMediaType: 'video',

        keywords: ['military history', 'world war', 'battle', 'warfare history', 'army history',
                   'navy history', 'aircraft history', 'tank history', 'weapons technology',
                   'military documentary', 'war documentary', 'historical battle', 'military strategy',
                   'naval history', 'air force history', 'special forces history', 'cold war',
                   'arms race', 'military technology', 'defense industry', 'military museum',
                   'veteran', 'war memorial', 'operation history',
                   // Geopolitical explainer terms
                   'geopolitics', 'geopolitical', 'alliance', 'sanctions', 'diplomacy',
                   'superpower', 'global power', 'strategic', 'defense system', 'missile defense',
                   'drone technology', 'drone warfare', 'cyber warfare', 'arms deal',
                   'military aid', 'defense budget', 'military base', 'nuclear',
                   'nato', 'indo-pacific', 'deterrence', 'escalation',
                   // Maritime / chokepoint conflict terms (Bab el-Mandeb, Hormuz, Red Sea analyses)
                   'naval power', 'naval blockade', 'naval forces', 'fleet deployment',
                   'warship', 'destroyer', 'aircraft carrier', 'submarine', 'patrol boat',
                   'houthi', 'iran navy', 'irgc', 'pentagon', 'central command',
                   'shipping disruption', 'maritime conflict', 'maritime security',
                   'chokepoint', 'strait', 'tanker attack', 'missile strike',
                   'red sea', 'bab el-mandeb', 'hormuz', 'persian gulf', 'south china sea'],

        searchPolicy: {
            contextTerms: ['military', 'documentary', 'geopolitical', 'analysis'],
            avoidTerms: ['cartoon', 'game', 'fiction', 'call of duty', 'anime', 'breaking news'],
            fallbackKeywords: ['military history documentary', 'geopolitical map animation', 'defense technology', 'naval fleet historical'],
            entityBoost: true,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Named operation/battle → keyword = operation or battle name (e.g., "D-Day Normandy 1944", "Battle of Midway")',
                'Military hardware → keyword = specific equipment + era (e.g., "Spitfire WWII fighter", "M1 Abrams tank")',
                'Historical figure → keyword = name + context (e.g., "Patton portrait", "Churchill war room")',
                'Strategic concept → keyword = visual representation (e.g., "trench warfare WWI", "naval blockade map")',
            ],
            examples: {
                good: ['"D-Day Normandy beach"', '"Spitfire WWII dogfight"', '"aircraft carrier deck historical"', '"tank Kursk battle"'],
                bad: ['"military operation"', '"war zone news"', '"breaking conflict"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'medium',
            maxOverlays: 4,
            minGapSec: 12,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    'explainer.tech': {
        id: 'explainer.tech',
        _parent: 'explainer',
        name: 'Tech Explainer',
        description: 'How technology works — science, engineering, AI/ML concepts, product deep-dives, NOT breaking tech news',

        defaultTheme: 'modern',

        shotStyle: 'Clean studio-lit hardware shots, server room aerials, circuit board macro close-ups, software UI screencasts, factory/fab lab interiors, product cross-section diagrams, engineering blueprint overlays.',

        // Rich MG treatment — educational tech gets full explainer graphics
        allowedMGs: [
            'headline', 'lowerThird', 'bulletList', 'statCounter', 'barChart', 'donutChart',
            'timeline', 'comparisonCard', 'focusWord', 'callout', 'explainer',
            'progressBar', 'rankingList', 'kineticText', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'storyblocks', 'reddit'],
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'moderate',
        preferredMediaType: 'mixed',

        keywords: ['how it works', 'technology explained', 'engineering explained', 'science explained',
                   'how does', 'how ai works', 'machine learning explained', 'quantum computing',
                   'semiconductor', 'processor', 'chip fabrication', 'how internet works',
                   'blockchain explained', 'electric vehicle technology', 'how battery works',
                   'solar panel technology', 'nuclear reactor', 'space technology', 'rocket science',
                   'robotics', 'automation', 'neural network', 'deep learning', 'algorithm explained'],

        searchPolicy: {
            contextTerms: ['explained', 'how it works', 'technology'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'presenter', 'talking head', 'breaking news'],
            fallbackKeywords: ['technology explainer', 'engineering cross section', 'circuit board close up', 'data center aerial'],
            entityBoost: true,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'concept-visual',
            rules: [
                'Technology/product → keyword = specific component or process (e.g., "CPU die shot", "lithium battery cross section")',
                'Abstract concept → keyword = visual representation (e.g., "neural network diagram", "satellite orbit animation")',
                'Company/product mentioned → keyword = product + technical context (e.g., "Tesla battery pack", "NVIDIA GPU chip")',
                'Prefer CLEAN B-roll: hardware close-ups, diagrams, lab footage — NO presenters',
            ],
            examples: {
                good: ['"CPU silicon wafer fabrication"', '"lithium battery cross section"', '"server rack data center"', '"robot arm assembly factory"'],
                bad: ['"tech news"', '"technology launch"', '"breaking AI update"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 6,
            minGapSec: 8,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    'explainer.politics': {
        id: 'explainer.politics',
        _parent: 'explainer',
        name: 'Politics & Policy Explainer',
        description: 'Long-form political & GEOPOLITICAL analysis — international relations, trade routes/chokepoints, sanctions, diplomacy, energy/shipping strategy, policy deep-dives, speculative scenarios, documentary-style. NOT breaking news',

        defaultTheme: 'modern',

        shotStyle: 'Capitol/parliament exteriors, archival policy footage, summit handshakes, chokepoint/trade-route maps, economic infographics, embassy shots, satellite imagery of strategic geography, document close-ups, policy think-tank interiors, historical presidential footage.',

        allowedMGs: [
            'headline', 'lowerThird', 'mapChart', 'timeline', 'statCounter',
            'focusWord', 'callout', 'bulletList', 'kineticText', 'typewriter',
            'barChart', 'comparisonCard'
        ],

        // YouTube first — same reasoning as news.politics, where the full note
        // lives. This niche carried the identical stock-first + scoutDemote lock.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'moderate',
        preferredMediaType: 'video',

        keywords: ['policy analysis', 'political analysis', 'geopolitical analysis', 'policy explainer',
                   'think tank', 'diplomacy history', 'sanctions regime', 'trade policy',
                   'foreign policy', 'international relations', 'policy deep dive',
                   'strategic chokepoint', 'trade route', 'shipping lane', 'shipping route',
                   'energy policy', 'energy security', 'oil route', 'pipeline politics',
                   'strait', 'canal geopolitics', 'maritime', 'tanker', 'cargo ship',
                   'blockade', 'embargo', 'suez', 'hormuz', 'bab el-mandeb', 'red sea',
                   'south china sea', 'persian gulf', 'shipping disruption',
                   'alliance history', 'treaty analysis', 'doctrine', 'hegemony',
                   'realpolitik', 'balance of power', 'grand strategy', 'statecraft',
                   'constitutional', 'supreme court history', 'political history',
                   'scenario', 'speculative', 'what if', 'could change'],

        searchPolicy: {
            contextTerms: ['policy', 'geopolitical', 'analysis', 'documentary'],
            avoidTerms: ['cartoon', 'meme', 'satire', 'parody', 'game', 'breaking news'],
            fallbackKeywords: ['capitol building wide shot', 'world map geopolitics', 'diplomatic summit handshake', 'shipping lane aerial', 'parliament session interior'],
            entityBoost: true,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Named policy/treaty → keyword = specific document + context (e.g., "JCPOA nuclear deal signing", "Paris Agreement ceremony")',
                'Political figure → keyword = name + setting (e.g., "Kissinger oval office", "Merkel Brussels summit")',
                'Geographic chokepoint → keyword = location + feature (e.g., "Strait of Hormuz tanker", "Suez Canal aerial")',
                'Institution → keyword = building/chamber (e.g., "US Capitol dome", "UN Security Council chamber")',
                'Strategic concept → keyword = visual representation (e.g., "global trade routes map", "NATO military exercise")',
            ],
            examples: {
                good: ['"Strait of Hormuz oil tanker"', '"White House West Wing"', '"NATO Brussels headquarters"', '"cargo ship Suez Canal aerial"'],
                bad: ['"political situation"', '"policy matter"', '"world leaders discussing"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'medium',
            maxOverlays: 4,
            minGapSec: 12,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    // ────────────────────────────────────────────────────
    // NEW NEWS SUB-NICHE
    // ────────────────────────────────────────────────────

    'news.sport': {
        id: 'news.sport',
        _parent: 'news',
        name: 'Sports News / Breaking',
        description: 'Breaking sports news, transfer rumors, match results, sports scandals — footage-driven, NOT documentary',

        defaultTheme: 'modern',

        shotStyle: 'Press conference podiums, stadium establishing shots, athlete walkout/warm-up footage, post-match interviews, training ground clips, trophy presentations.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'focusWord', 'typewriter'
        ],

        // YouTube first. Sport is highlights — the specific goal, the specific
        // finish, the specific press conference. Reddit stays a strong second
        // (r/sports mirrors clips fast); stock has anonymous stadium b-roll.
        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        excludeVideoProviders: [],

        defaultPacing: 'fast',
        preferredMediaType: 'video',

        keywords: ['transfer', 'signing', 'contract', 'fired', 'sacked', 'injured', 'injury',
                   'ban', 'suspension', 'scandal', 'breaking sports', 'sports news', 'match result',
                   'final score', 'champion', 'title race', 'knockout round', 'playoff', 'draft',
                   'trade', 'free agent', 'manager sacked', 'coach fired', 'record breaking'],

        searchPolicy: {
            contextTerms: ['sports', 'breaking', 'news'],
            avoidTerms: ['cartoon', 'anime', 'esports', 'game screenshot'],
            fallbackKeywords: ['sports press conference', 'stadium crowd', 'athlete training', 'trophy ceremony'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Player/manager named → keyword = name + current context (e.g., "Mbappé Real Madrid", "Klopp Liverpool farewell")',
                'Transfer/result → keyword = specific event (e.g., "Champions League final 2024", "NFL draft pick")',
                'Injury/scandal → keyword = player name + event (e.g., "Ronaldo injury training", "boxing controversy")',
                'Always use real names and current events — sports news needs specificity',
            ],
            examples: {
                good: ['"Champions League trophy ceremony"', '"NFL press conference"', '"soccer training ground"', '"basketball arena crowd"'],
                bad: ['"sports news"', '"athletic event"', '"sports competition update"'],
            }
        },
    },

    // ────────────────────────────────────────────────────
    // FLAT FALLBACK
    // ────────────────────────────────────────────────────

    general: {
        id: 'general',
        name: 'General/Neutral',
        description: 'General-purpose, versatile, any topic',

        defaultTheme: 'standard',

        shotStyle: 'Mix of wide establishing shots, medium close-ups, and aerial perspectives. Vary between static and slow movement. Match lighting to the mood of each scene.',

        // All MG types allowed (unrestricted fallback)
        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'callout', 'bulletList',
            'focusWord', 'progressBar', 'barChart', 'donutChart', 'comparisonCard',
            'timeline', 'rankingList', 'kineticText', 'mapChart',
            'explainer', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'storyblocks'],
            image: ['storyblocks']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // general: no strong bias

        keywords: [], // Fallback niche — matches when nothing else does

        searchPolicy: {
            contextTerms: [],
            avoidTerms: ['cartoon', 'clipart', 'illustration'],
            fallbackKeywords: ['abstract background', 'cinematic landscape', 'aerial city view'],
            entityBoost: true,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'balanced',
            rules: [
                'Person named → keyword = their name (e.g., "Elon Musk", "Taylor Swift")',
                'Specific event → keyword = event descriptor (e.g., "solar eclipse 2024", "Olympic opening ceremony")',
                'No specific entity → keyword = concrete visual subject (e.g., "city skyline sunset", "office workspace")',
                'Keep keywords between 3-6 words, directly searchable, no abstract concepts',
            ],
            examples: {
                good: ['"city skyline sunset"', '"Elon Musk portrait"', '"laptop coffee desk"', '"crowd concert night"'],
                bad: ['"interesting concept"', '"important topic"', '"various things happening"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'medium',
            maxOverlays: 4,
            minGapSec: 12,
            preferredTypes: ['v2', 'explainer'],
        }
    }
};

// ============================================================
// NICHE DETECTION (keyword-based, no AI cost)
// ============================================================

const NICHE_EVIDENCE_WEIGHTS = {
    title: 4,
    summary: 2,
    entities: 2,
    sections: 2,
    fullScript: 1,
    context: 1,
};

function _buildNicheEvidenceFields(scriptContext = {}, opts = {}) {
    const fields = [
        { name: 'title', text: scriptContext.videoTitle || '', weight: NICHE_EVIDENCE_WEIGHTS.title },
        { name: 'summary', text: scriptContext.summary || '', weight: NICHE_EVIDENCE_WEIGHTS.summary },
        { name: 'entities', text: (scriptContext.entities || []).join(' '), weight: NICHE_EVIDENCE_WEIGHTS.entities },
        { name: 'sections', text: (scriptContext.sections || []).join(' '), weight: NICHE_EVIDENCE_WEIGHTS.sections },
        { name: 'fullScript', text: opts.fullScript || '', weight: NICHE_EVIDENCE_WEIGHTS.fullScript },
        {
            name: 'context',
            text: [
                scriptContext.tone,
                scriptContext.mood,
                scriptContext.visualStyle,
                scriptContext.format,
                scriptContext.eventType,
            ].filter(Boolean).join(' '),
            weight: NICHE_EVIDENCE_WEIGHTS.context,
        },
    ].map(field => ({
        ...field,
        text: String(field.text || '').toLowerCase(),
    }));

    return {
        fields,
        all: fields.map(field => field.text).filter(Boolean).join(' '),
    };
}

function _keywordRegex(keyword) {
    const escaped = String(keyword || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}(?:s|es|ed|ing)?\\b`, 'i');
}

function _scoreKeywordEvidence(keywords = [], evidence = null) {
    const fields = evidence?.fields || [{ name: 'all', text: String(evidence?.all || '').toLowerCase(), weight: 1 }];
    const byField = {};
    const matches = [];
    let total = 0;

    for (const keyword of keywords) {
        const re = _keywordRegex(keyword);
        let keywordMatched = false;

        for (const field of fields) {
            if (!field.text || !re.test(field.text)) continue;
            const points = field.weight || 1;
            total += points;
            byField[field.name] = (byField[field.name] || 0) + points;
            keywordMatched = true;
        }

        if (keywordMatched) matches.push(keyword);
    }

    return { total, byField, matches };
}

function _normalizeNicheHint(nicheHint) {
    const id = String(nicheHint || '').trim().toLowerCase();
    if (!id || id === 'auto' || id === 'none' || id === 'n/a') return '';
    return NICHES[id] ? id : '';
}

/**
 * Pick the best niche based on script context from AI Director.
 * Uses the AI's topic analysis (summary, theme, entities) to keyword-match.
 * @param {Object} scriptContext - AI Director's analysis
 * @param {Object} [opts] - Optional extras for stability-critical tie-breaks
 * @param {string} [opts.fullScript] - Full transcript text. When provided, used
 *   by the politics documentary/breaking resolver to count explanatory framing
 *   across the whole narration rather than only the short summary.
 * @param {number} [opts.audioDuration] - Audio duration in seconds. Longer =
 *   stronger documentary bias. Missing → duration signal contributes 0.
 * @returns {string} nicheId
 */
function pickNicheFromContent(scriptContext, opts = {}) {
    if (!scriptContext || (!scriptContext.summary && !scriptContext.videoTitle)) {
        return 'general';
    }

    const evidence = _buildNicheEvidenceFields(scriptContext, opts);
    const text = evidence.all;
    if (scriptContext.videoTitle) {
        console.log(`      [Video title]: "${scriptContext.videoTitle}"`);
    }

    // Also check the AI's explicit theme field as a strong signal
    const aiTheme = (scriptContext.theme || '').toLowerCase();
    const aiNicheHint = _normalizeNicheHint(scriptContext.nicheHint);
    if (aiNicheHint) {
        console.log(`      [AI niche hint]: ${aiNicheHint}`);
    }

    // ── EVENT TYPE + TONE: strongest signal for news vs explainer ──
    // AI Director outputs: eventType (real-past|real-ongoing|speculative|educational|fictional)
    //                      tone (urgent|informative|dramatic|educational|serious|...)
    // These distinguish "breaking news about tech" from "how tech works" better than keywords
    const eventType = (scriptContext.eventType || '').toLowerCase();
    const tone = (scriptContext.tone || '').toLowerCase();

    // NEWS signals: real events with urgent/serious tone
    let isNewsSignal = (eventType === 'real-ongoing' || eventType === 'real-past') &&
                       (tone === 'urgent' || tone === 'serious' || tone === 'dramatic');
    // EXPLAINER signals: educational content with informative tone
    let isExplainerSignal = eventType === 'educational' ||
                              tone === 'educational' ||
                              (eventType === 'speculative' && tone === 'informative');

    const titleAndSummary = ((scriptContext.videoTitle || '') + ' ' + (scriptContext.summary || '')).toLowerCase();

    // ── Active-conflict content gate ──
    // When content is about a current war/military operation AND eventType=real-ongoing,
    // it's NEWS regardless of clickbait title or documentary format. Historical military
    // content is real-past (explainer.military) — this only fires for ongoing events.
    const activeConflictKeywords = [
        'putin', 'zelensky', 'kyiv', 'ukraine', 'kharkiv', 'donbas', 'crimea',
        'israel', 'gaza', 'hamas', 'hezbollah', 'iran', 'houthi', 'red sea',
        'taiwan', 'china invasion', 'south china sea', 'nato', 'frontline',
        'airstrike', 'missile strike', 'drone strike', 'shahed', 'himars',
        'invasion', 'offensive', 'counteroffensive', 'war crimes',
    ];
    const hasActiveConflict = activeConflictKeywords.some(k => titleAndSummary.includes(k));
    const isOngoingConflict = eventType === 'real-ongoing' && hasActiveConflict;

    // ── Content structure analysis: detect explainer/documentary patterns ──
    // Long-form analysis about military/geopolitical topics uses documentary language,
    // not breaking news language. These patterns override weak news signals.
    const explainerPatterns = [
        /\b(?:how|why)\b.*\b(?:works?|changed?|became|built|designed|explained)\b/i,
        /\b(?:explained|analysis|deep dive|breakdown|documentary)\b/i,
        /\b(?:history of|evolution of|future of|rise of|fall of)\b/i,
        /\b(?:what (?:is|are|makes|happened)|how (?:did|does|do|can|to))\b/i,
        /\b(?:everything you need to know|complete guide|full story)\b/i,
        // NOTE: clickbait "insane/incredible/shocking" words were matching news titles
        // like "What Japan Did for Ukraine Is INSANE..." — require a clearly educational
        // verb (explained/works/designed) nearby, otherwise these are news headlines.
        /\b(?:insane|incredible|unbelievable|shocking)\b.*\b(?:works?|explained|designed|built how|built to)\b/i,
    ];
    const explainerPatternHits = explainerPatterns.filter(p => p.test(titleAndSummary)).length;
    if (explainerPatternHits >= 1 && !isExplainerSignal && !isOngoingConflict) {
        isExplainerSignal = true;
        console.log(`      [Content structure]: ${explainerPatternHits} explainer pattern(s) detected in title/summary → EXPLAINER signal`);
    }

    // ── Format signal: documentary format = explainer ──
    // BUT: a documentary about an ONGOING conflict is still news (live war coverage,
    // not historical/analytical). Only treat documentary format as explainer when the
    // event isn't actively unfolding.
    const format = (scriptContext.format || '').toLowerCase();
    if ((format === 'documentary' || format === 'essay' || format === 'analysis') && !isExplainerSignal && !isOngoingConflict) {
        isExplainerSignal = true;
        console.log(`      [Format signal]: format="${format}" → EXPLAINER signal`);
    }

    // ── Tie-break: ongoing conflict always wins news ──
    // If the content is clearly an ongoing conflict, force NEWS signal and clear explainer.
    // Prevents "real-ongoing + dramatic + documentary format" from landing on explainer.tech
    // when the script is actually defense/war news (Japan/Ukraine, Israel/Gaza, etc.).
    if (isOngoingConflict) {
        isNewsSignal = true;
        if (isExplainerSignal) {
            console.log(`      [Active conflict override]: eventType=real-ongoing + war keywords → NEWS wins over EXPLAINER`);
            isExplainerSignal = false;
        }
    }

    // Log the signals for debugging
    if (isNewsSignal || isExplainerSignal) {
        console.log(`      [Event signals]: eventType=${eventType || 'none'} tone=${tone || 'none'} → ${isNewsSignal ? 'NEWS' : ''}${isExplainerSignal ? 'EXPLAINER' : ''}`);
    }

    // Direct mapping from AI theme → parent niche category (explainer or news)
    // Crime, history, nature etc. are ALWAYS explainer — never news regardless of tone
    const THEME_TO_NICHE = {
        // Always explainer — educational/documentary regardless of tone
        'science': 'explainer',
        'engineering': 'explainer',
        'architecture': 'explainer',
        'construction': 'explainer',
        'education': 'explainer',
        'documentary': 'explainer',
        'nature': 'explainer',         // → sub-niche: explainer.nature
        'wildlife': 'explainer',       // → sub-niche: explainer.nature
        'travel': 'explainer',         // → sub-niche: explainer.nature
        'crime': 'explainer',          // ALWAYS documentary — NEVER breaking news
        'mystery': 'explainer',        // ALWAYS explainer
        'history': 'explainer',        // ALWAYS documentary — NEVER breaking news
        'biography': 'explainer',      // → sub-niche: explainer.history
        'lifestyle': 'explainer',      // → sub-niche: explainer.luxury
        'luxury': 'explainer',         // → sub-niche: explainer.luxury
        'fashion': 'explainer',        // → sub-niche: explainer.luxury
        'motivation': 'explainer',     // → sub-niche: explainer.motivation
        'self-improvement': 'explainer',
        'food': 'explainer',           // → sub-niche: explainer.food
        'nutrition': 'explainer',      // → sub-niche: explainer.food
        'cooking': 'explainer',        // → sub-niche: explainer.food
        'health': 'explainer',         // → sub-niche: explainer.food
        'diy': 'explainer',            // → sub-niche: explainer.diy
        'crafts': 'explainer',         // → sub-niche: explainer.diy
        'home improvement': 'explainer',

        // Always news — breaking/current events
        // 'politics' moved to AMBIGUOUS_THEMES — documentary/speculative tone flips it to explainer.politics
        'entertainment': 'news',       // → sub-niche: news.celebrity
        'celebrity': 'news',           // → sub-niche: news.celebrity
        'gossip': 'news',              // → sub-niche: news.celebrity

        // Ambiguous — resolved below by event signals + keywords:
        // 'technology', 'tech', 'military', 'defense', 'war', 'geopolitics',
        // 'sports', 'sport', 'business', 'finance', 'economy', 'markets'
    };

    // Ambiguous themes — one theme string can mean either category depending on content type.
    // Key: AI theme string → { explainer parent result, news parent result, default if no signal }
    // "What Japan Did for Ukraine" = explainer.military (geopolitical analysis, documentary)
    // "Russia Attacks Kharkiv — Breaking" = news.military (urgent breaking event)
    const AMBIGUOUS_THEMES = {
        'technology':  { ifExplainer: 'explainer', ifNews: 'news', defaultTo: null },       // null = let keyword scoring decide
        'tech':        { ifExplainer: 'explainer', ifNews: 'news', defaultTo: null },
        'military':    { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' }, // most long-form military = documentary/analysis
        'defense':     { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'war':         { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'news' },      // "war" alone leans news (active conflict)
        'geopolitics': { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' }, // geopolitics analysis = usually explainer
        'geopolitical':{ ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'politics':    { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'news' },      // breaking by default; doc/speculative tone flips to explainer.politics
        'policy':      { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'sports':      { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'sport':       { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'business':    { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'finance':     { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'explainer' },
        'economy':     { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'news' },
        'markets':     { ifExplainer: 'explainer', ifNews: 'news', defaultTo: 'news' },
    };

    let directMatch = THEME_TO_NICHE[aiTheme];
    if (!directMatch) {
        const amb = AMBIGUOUS_THEMES[aiTheme];
        if (amb) {
            // News wins first when the content is actively unfolding — overrides any
            // lingering isExplainerSignal that slipped through the earlier gates.
            if (isNewsSignal) {
                directMatch = amb.ifNews;
                console.log(`      [Theme resolve]: ${aiTheme} + news signal → ${directMatch}`);
            } else if (isExplainerSignal) {
                directMatch = amb.ifExplainer;
                console.log(`      [Theme resolve]: ${aiTheme} + educational signal → ${directMatch}`);
            } else if (amb.defaultTo) {
                directMatch = amb.defaultTo;
                console.log(`      [Theme resolve]: ${aiTheme} + no signal → default ${directMatch}`);
            }
            // If no signal and no default, keyword scoring decides (no directMatch boost)
        }
    }

    // ── AI-AUTHORITATIVE NICHE ──────────────────────────────────────────────
    // The Director read the ENTIRE script and picked a niche from the canonical
    // list. That semantic judgment is the brain of the app — it must decide, not
    // a hardcoded keyword list. So when the AI returns a specific, valid niche we
    // RETURN IT and skip the keyword-scoring + conflict-pivot machinery entirely.
    // Those remain only as a FALLBACK for when the AI gives nothing usable. This
    // is what keeps the tool topic-agnostic/global — no per-topic word list should
    // ever override the model's choice. (User directive: the LLM exists precisely
    // to avoid hardcoded topic words.)
    if (aiNicheHint && aiNicheHint !== 'general' && NICHES[aiNicheHint]) {
        const hintHasChildren = Object.values(NICHES).some(n => n._parent === aiNicheHint);
        if (!hintHasChildren) {
            console.log(`      [Niche] AI-authoritative → ${aiNicheHint} (Director's semantic choice; keyword scoring skipped)`);
            return aiNicheHint;
        }
        // AI returned a bare PARENT (e.g. "explainer") — keep it as a strong bias
        // and let sub-niche detection refine within it.
        directMatch = aiNicheHint;
        console.log(`      [Niche hint]: ${aiNicheHint} (parent) — refining sub-niche`);
    }

    // Active-conflict pivot: if we detected an ongoing conflict, the AI theme is
    // often the surface topic (tech/technology/business) while the real subject is
    // military. Pivot to news.military so footage strategy matches.
    if (isOngoingConflict) {
        directMatch = 'news';
    }

    // Score each TOP-LEVEL niche based on keyword matches (word-boundary aware)
    // Sub-niches (with _parent) are scored separately after parent is selected.
    // For parent niches (explainer/news), fold in ALL sub-niche keywords so that e.g. crime or
    // nature keywords make 'explainer' score highly even though those sub-niche keywords aren't
    // on the parent itself.
    const scores = {};
    for (const [nicheId, niche] of Object.entries(NICHES)) {
        if (nicheId === 'general') continue;
        if (niche._parent) continue; // Skip sub-niches — handled by _detectSubNiche

        // Combine parent keywords + all sub-niche keywords for scoring
        let scoreKeywords = [...(niche.keywords || [])];
        for (const sub of Object.values(NICHES)) {
            if (sub._parent === nicheId && sub.keywords) {
                scoreKeywords = scoreKeywords.concat(sub.keywords);
            }
        }

        let score = _scoreKeywordEvidence(scoreKeywords, evidence).total;
        // Boost if AI theme directly maps to this niche
        if (directMatch === nicheId) score += 3;

        // Event signal boosts: strong override for ambiguous keyword scores
        if (isExplainerSignal && nicheId === 'explainer') score += 4;
        if (isNewsSignal && nicheId === 'news') score += 4;

        scores[nicheId] = score;
    }

    let bestNiche = 'general';
    let bestScore = 0;
    for (const [nicheId, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score;
            bestNiche = nicheId;
        }
    }

    // Active-conflict override: force news parent when war keywords + real-ongoing detected
    if (isOngoingConflict && bestNiche !== 'news') {
        console.log(`      [Active conflict override]: parent pivoted ${bestNiche} → news (war keywords + real-ongoing)`);
        bestNiche = 'news';
    }

    // Sub-niche detection: if parent niche has sub-niches, pick the best one
    const subNicheResult = _detectSubNiche(bestNiche, text, aiTheme, {
        preferMilitary: isOngoingConflict,
        evidence,
        aiNicheHint,
    });
    let finalNiche = subNicheResult || bestNiche;

    // Politics stability resolver — only fires when choice is news.politics OR
    // explainer.politics. Uses deterministic documentary-vs-breaking signal
    // scoring (explanatory framing, systemic vocabulary, format, duration vs
    // breaking-event markers) with a 1-point stability bias toward explainer.
    // Rationale: same longform geopolitics script was flipping between the two
    // based on noisy AI tone/eventType output, producing 65 vs 112 scenes.
    if (finalNiche === 'news.politics' || finalNiche === 'explainer.politics') {
        finalNiche = _resolvePoliticsAmbiguity(finalNiche, scriptContext, opts);
    }

    return finalNiche;
}

/**
 * Documentary-vs-breaking resolver for the politics ambiguous zone.
 * Deterministic scoring with clear tie-break.
 * Only called when current pick is news.politics or explainer.politics.
 *
 * @param {string} currentChoice Current sub-niche decision.
 * @param {Object} scriptContext AI Director output.
 * @param {Object} opts {fullScript?, audioDuration?}
 * @returns {string} 'news.politics' or 'explainer.politics'
 */
function _resolvePoliticsAmbiguity(currentChoice, scriptContext, opts) {
    const fullScript = (opts && typeof opts.fullScript === 'string') ? opts.fullScript : '';
    const audioDuration = (opts && typeof opts.audioDuration === 'number') ? opts.audioDuration : 0;

    // Body text for pattern counting: full script when available, else title+summary.
    const bodyText = (fullScript
        || ((scriptContext.videoTitle || '') + ' ' + (scriptContext.summary || ''))
    ).toLowerCase();

    const titleSummary = ((scriptContext.videoTitle || '') + ' ' + (scriptContext.summary || '')).toLowerCase();
    const format = (scriptContext.format || '').toLowerCase();

    // ── Explanatory framing (documentary signal) ──
    // Phrases that mark "this is an analytical explainer". Capped contribution
    // so a few strong hits count without a single overloaded transcript dominating.
    const EXPLANATORY_PATTERNS = [
        /\bwhy\s+(?:is|are|did|does|do|this|that|has|have|was|were|would|will)\b/g,
        /\bhow\s+(?:did|does|do|can|could|will|the|this|that|exactly)\b/g,
        /\bwhat\s+happens\s+(?:if|when|next)\b/g,
        /\bwhat\s+(?:this|it|that)\s+means\b/g,
        /\bthe\s+reason\b/g,
        /\bthis\s+means\b/g,
        /\bconsequences?\b/g,
        /\bimplications?\b/g,
        /\bthe\s+system\b/g,
        /\bthe\s+route\b/g,
        /\bthe\s+economy\b/g,
        /\bchokepoints?\b/g,
        /\btrade\s+routes?\b/g,
        /\bsupply\s+chains?\b/g,
        /\brerout(?:e|ed|es|ing)\b/g,
        /\bshipping\s+lanes?\b/g,
        /\bescalation\b/g,
        /\binfrastructure\b/g,
        /\bstrategic(?:ally)?\b/g,
        /\bover\s+(?:the\s+years|decades)\b/g,
        /\bin\s+the\s+long\s+run\b/g,
        /\bfundamental(?:ly)?\b/g,
        /\bdeep\s+dive\b/g,
        /\bbreakdown\b/g,
        /\banalysis\b/g,
    ];

    let docPatternHits = 0;
    for (const re of EXPLANATORY_PATTERNS) {
        const m = bodyText.match(re);
        if (m) docPatternHits += m.length;
    }
    // Cap so one pattern repeated 40× can't swamp the score.
    const docPatternScore = Math.min(4, Math.floor(docPatternHits / 2));

    // Format signal.
    let docFormatScore = 0;
    if (format === 'documentary' || format === 'essay' || format === 'analysis' || format === 'explainer') {
        docFormatScore = 3;
    }

    // Duration signal. Thresholds chosen from real builds:
    // good explainer run was 498s; breaking-update formats are usually <180s.
    let docDurationScore = 0;
    if (audioDuration >= 900) docDurationScore = 3;
    else if (audioDuration >= 600) docDurationScore = 2;
    else if (audioDuration >= 300) docDurationScore = 1;

    const docScore = docPatternScore + docFormatScore + docDurationScore;

    // ── Breaking-news markers ──
    const BREAKING_PATTERNS = [
        /\bbreaking\b/g,
        /\bjust\s+(?:announced|confirmed|said|reported|released)\b/g,
        /\bthis\s+morning\b/g,
        /\bthis\s+afternoon\b/g,
        /\blast\s+night\b/g,
        /\blive\s+(?:update|coverage|from)\b/g,
        /\bminutes?\s+ago\b/g,
        /\bhours?\s+ago\b/g,
        /\belection\s+results?\b/g,
        /\bpress\s+conference\b/g,
        /\bceasefire\b/g,
        /\bsummit\s+(?:began|starts|ends|ended|concluded)\b/g,
        /\b(?:president|leader|minister|senator)\s+(?:announced|confirmed|said)\b/g,
        /\breact(?:ed|ing|ion)\s+to\b/g,
    ];

    let breakingPatternHits = 0;
    for (const re of BREAKING_PATTERNS) {
        const m = bodyText.match(re);
        if (m) breakingPatternHits += m.length;
    }
    const breakingPatternScore = Math.min(4, breakingPatternHits);

    // Title explicitly says "breaking" / "update" → strong breaking signal.
    let breakingTitleScore = 0;
    if (/\bbreaking\b/.test(titleSummary)) breakingTitleScore += 2;
    if (/\bupdate\b/.test(titleSummary))  breakingTitleScore += 1;

    // Short duration reinforces breaking.
    let breakingDurationScore = 0;
    if (audioDuration > 0 && audioDuration < 120) breakingDurationScore = 3;
    else if (audioDuration > 0 && audioDuration < 180) breakingDurationScore = 2;

    const breakingScore = breakingPatternScore + breakingTitleScore + breakingDurationScore;

    // ── Tie-break ──
    // Stability bias: when signals are close, prefer explainer.politics.
    // If no politics-specific evidence exists in either direction, keep the
    // current choice (trust upstream logic).
    let winner;
    let reason;
    if (docScore === 0 && breakingScore === 0) {
        winner = currentChoice;
        reason = 'no-politics-signal';
    } else if (docScore >= breakingScore - 1) {
        winner = 'explainer.politics';
        reason = (docScore > breakingScore)
            ? 'doc>breaking'
            : 'close-tie-stability-bias';
    } else {
        winner = 'news.politics';
        reason = 'breaking-dominant';
    }

    console.log(`      [Politics resolver]: doc=${docScore} (patterns=${docPatternScore}, format=${docFormatScore}, duration=${docDurationScore}) breaking=${breakingScore} (patterns=${breakingPatternScore}, title=${breakingTitleScore}, duration=${breakingDurationScore}) dur=${audioDuration.toFixed ? audioDuration.toFixed(0) : audioDuration}s fullScript=${fullScript ? 'yes' : 'no'} [${currentChoice} → ${winner} | ${reason}]`);

    return winner;
}

/**
 * Detect sub-niche within a parent niche by scoring sub-niche keywords.
 * @param {string} parentId - e.g., 'news'
 * @param {string} text - lowercase text blob for matching
 * @param {string} aiTheme - AI's explicit theme string
 * @returns {string|null} Sub-niche ID (e.g., 'news.politics') or null to keep parent
 */
function _detectSubNiche(parentId, text, aiTheme, opts = {}) {
    // Find all sub-niches for this parent
    const subNiches = Object.entries(NICHES).filter(([_, n]) => n._parent === parentId);
    if (subNiches.length === 0) return null;

    // Active-conflict pivot: if caller detected an ongoing military conflict, bypass the
    // AI-theme mapping entirely — AI often picks "technology" (drones, companies) when the
    // real subject is war news, which incorrectly lands on news.tech / explainer.tech.
    if (opts.preferMilitary) {
        const militaryId = `${parentId}.military`;
        if (NICHES[militaryId]) {
            console.log(`      [Sub-niche pivot]: active conflict detected → ${militaryId} (bypassed AI theme "${aiTheme}")`);
            return militaryId;
        }
    }

    // AI theme → sub-niche, organized by parent category.
    // Using hierarchical map prevents a 'military' AI theme from picking news.military
    // when the parent is 'explainer' (would pick explainer.military instead).
    const SUB_NICHE_THEME_MAP = {
        explainer: {
            'nature': 'explainer.nature',
            'wildlife': 'explainer.nature',
            'travel': 'explainer.nature',
            'environment': 'explainer.nature',
            'climate': 'explainer.nature',
            'crime': 'explainer.crime',
            'mystery': 'explainer.crime',
            'true crime': 'explainer.crime',
            'thriller': 'explainer.crime',
            'history': 'explainer.history',
            'biography': 'explainer.history',
            'historical': 'explainer.history',
            'ancient': 'explainer.history',
            'luxury': 'explainer.luxury',
            'fashion': 'explainer.luxury',
            'sports': 'explainer.sport',
            'sport': 'explainer.sport',
            'athletic': 'explainer.sport',
            'motivation': 'explainer.motivation',
            'self-improvement': 'explainer.motivation',
            'mindset': 'explainer.motivation',
            'food': 'explainer.food',
            'nutrition': 'explainer.food',
            'cooking': 'explainer.food',
            'health': 'explainer.food',
            'diy': 'explainer.diy',
            'crafts': 'explainer.diy',
            'home improvement': 'explainer.diy',
            'tutorial': 'explainer.diy',
            'business': 'explainer.business',
            'finance': 'explainer.business',
            'economy': 'explainer.business',
            'markets': 'explainer.business',
            'corporate': 'explainer.business',
            'military': 'explainer.military',
            'defense': 'explainer.military',
            'war': 'explainer.military',       // historical war = explainer
            'geopolitics': 'explainer.politics',   // geopolitics = politics, not military
            'geopolitical': 'explainer.politics',
            'politics': 'explainer.politics',
            'policy': 'explainer.politics',
            'government': 'explainer.politics',
            'diplomacy': 'explainer.politics',
            'technology': 'explainer.tech',
            'tech': 'explainer.tech',
            'engineering': 'explainer.tech',
            'science': 'explainer.tech',
            'cyber': 'explainer.tech',
        },
        news: {
            'politics': 'news.politics',
            'geopolitics': 'news.politics',
            'government': 'news.politics',
            'election': 'news.politics',
            'economy': 'news.economy',
            'finance': 'news.economy',
            'markets': 'news.economy',
            'stocks': 'news.economy',
            'celebrity': 'news.celebrity',
            'entertainment': 'news.celebrity',
            'gossip': 'news.celebrity',
            'pop culture': 'news.celebrity',
            'military': 'news.military',
            'war': 'news.military',            // current conflict = news
            'defense': 'news.military',
            'conflict': 'news.military',
            'technology': 'news.tech',
            'tech': 'news.tech',
            'cyber': 'news.tech',
            'ai': 'news.tech',
            'sports': 'news.sport',
            'sport': 'news.sport',
            'football': 'news.sport',
            'basketball': 'news.sport',
            'soccer': 'news.sport',
        },
    };
    const parentMap = SUB_NICHE_THEME_MAP[parentId] || {};
    const hintedSub = (opts.aiNicheHint && NICHES[opts.aiNicheHint]?._parent === parentId)
        ? opts.aiNicheHint
        : null;
    const directSub = hintedSub || parentMap[aiTheme];
    const directSubSource = hintedSub ? 'nicheHint' : (directSub ? 'theme' : '');
    const evidence = opts.evidence || { all: text };

    // Always score ALL sub-niches by keyword matches — even if AI theme gave a direct hit.
    // A strong keyword signal (e.g., 8 military terms) should override a weak AI theme tag.
    const subScores = {};
    const subMatches = {};
    let bestSub = null;
    let bestScore = 0; // Minimum threshold — need at least 1 keyword hit to specialize
    for (const [subId, sub] of subNiches) {
        if (!sub.keywords) continue;
        const scored = _scoreKeywordEvidence(sub.keywords, evidence);
        const score = scored.total;
        const matches = scored.matches;
        subScores[subId] = score;
        subMatches[subId] = matches;
        if (score > bestScore) {
            bestScore = score;
            bestSub = subId;
        }
    }

    // Tiebreaker: when multiple sub-niches tie, prefer the one that matches AI theme.
    // If AI theme doesn't match any tied niche, pick based on content domain priority.
    //
    // DOMAIN_PRIORITY = "if these strong identity terms appear 2+ times, this niche
    // wins the tie even if AI theme pointed elsewhere". Lists are intentionally narrow:
    // each term must be a clearly-anchored signal of that domain (not a weak metaphor).
    // Maritime/chokepoint terms (strait, shipping lane, blockade, tanker, suez, hormuz,
    // bab el-mandeb, houthi, red sea) are added because long-form geopolitical analyses
    // about shipping disruption tie 1-1-1 between business/military/politics — without
    // these anchors, business wins via AI theme="finance" and the script gets routed
    // to corporate stock-footage instead of geopolitical maps + maritime footage.
    const DOMAIN_PRIORITY = {
        [`${parentId}.military`]: [
            'war', 'conflict', 'defense', 'weapon', 'army', 'drone', 'missile', 'combat', 'troops',
            'naval', 'navy', 'fleet', 'warship', 'destroyer', 'aircraft carrier',
            'houthi', 'iran navy', 'irgc', 'pentagon', 'airstrike', 'missile strike',
        ],
        [`${parentId}.politics`]: [
            'election', 'government', 'president', 'parliament', 'sanction', 'diplomacy', 'geopolit',
            'strait', 'chokepoint', 'shipping lane', 'shipping route', 'trade route', 'blockade',
            'embargo', 'oil route', 'energy security', 'maritime', 'tanker', 'cargo ship',
            'suez', 'hormuz', 'bab el-mandeb', 'bab-el-mandeb', 'red sea', 'south china sea',
            'pipeline', 'foreign policy', 'treaty', 'alliance',
        ],
    };

    // Geopolitical-anchor disqualifier for business: when 3+ chokepoint/maritime/
    // conflict terms appear AND the AI theme landed on business (because the script
    // mentions "stock market" or "global economy" once or twice), business is removed
    // from the tie pool. This prevents Strait of Hormuz / Bab el-Mandeb shipping
    // explainers from being routed to corporate b-roll just because they mention
    // economic impact.
    const GEOPOLITICAL_ANCHORS = [
        'strait', 'chokepoint', 'shipping lane', 'shipping route', 'trade route',
        'blockade', 'embargo', 'oil route', 'maritime', 'tanker', 'cargo ship',
        'suez', 'hormuz', 'bab el-mandeb', 'bab-el-mandeb', 'red sea', 'persian gulf',
        'south china sea', 'pipeline', 'naval', 'fleet', 'houthi', 'iran navy',
        'geopolit', 'sanction', 'foreign policy',
    ];
    const businessId = `${parentId}.business`;
    const geoHits = GEOPOLITICAL_ANCHORS.filter(t => text.includes(t)).length;

    if (bestSub && bestScore > 0) {
        const tied = Object.entries(subScores).filter(([_, s]) => s === bestScore);

        // Step 1: business disqualifier — geopolitical content masquerading as finance.
        if (
            geoHits >= 3 &&
            subScores[businessId] === bestScore &&
            (subScores[`${parentId}.military`] === bestScore || subScores[`${parentId}.politics`] === bestScore)
        ) {
            const newBest = subScores[`${parentId}.politics`] === bestScore
                ? `${parentId}.politics`
                : `${parentId}.military`;
            console.log(`      [Sub-niche disqualifier]: ${businessId} dropped — ${geoHits} geopolitical anchor terms found in script (chokepoint/maritime/sanction/etc.) → ${newBest} wins`);
            bestSub = newBest;
            // Recompute tied after disqualifier
            tied.length = 0;
            for (const [k, s] of Object.entries(subScores)) {
                if (s === bestScore && k !== businessId) tied.push([k, s]);
            }
        }

        // Step 2: standard DOMAIN_PRIORITY tiebreak for remaining ties.
        if (tied.length > 1) {
            // Check if directSub (AI theme match) is among the tied — if so, it's a valid tiebreaker
            if (directSub && subScores[directSub] === bestScore) {
                // AI theme is one of the tied — but check if another sub-niche is more domain-specific
                // military/politics content talking about "technology" is still military, not tech
                // War/conflict/defense terms are stronger identity signals than "technology"
                for (const [domainNiche, domainTerms] of Object.entries(DOMAIN_PRIORITY)) {
                    if (subScores[domainNiche] === bestScore && domainNiche !== directSub) {
                        const domainHits = domainTerms.filter(t => text.includes(t)).length;
                        if (domainHits >= 2) {
                            console.log(`      [Sub-niche tiebreak]: ${domainNiche} wins tie vs ${directSub} — ${domainHits} strong domain terms found`);
                            bestSub = domainNiche;
                            break;
                        }
                    }
                }
            }
        }
    }

    const weakBestSubSingleHit = _isWeakSubNicheSingleHit(bestSub, subMatches[bestSub]);

    // Log sub-niche scores for debugging
    const scoresSummary = Object.entries(subScores)
        .filter(([_, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id, s]) => `${id}(${s})`)
        .join(', ');
    if (scoresSummary) {
        const directLabel = directSub
            ? ` | ${directSubSource === 'nicheHint' ? 'AI-niche' : 'AI-theme'}→${directSub}`
            : '';
        console.log(`      [Sub-niche scores]: ${scoresSummary}${directLabel}`);
    }

    // If keyword scoring found a clear winner, use it — even over AI theme
    // Override AI theme if keyword winner beats it significantly
    if (directSub && NICHES[directSub]) {
        const directScore = subScores[directSub] || 0;
        const diff = bestScore - directScore;
        const ratio = directScore > 0 ? bestScore / directScore : bestScore;

        // If AI theme's sub-niche scored 0 keywords and a keyword winner exists,
        // the keyword evidence should win — the AI theme was likely wrong
        if (directScore === 0 && bestSub && bestSub !== directSub) {
            if (weakBestSubSingleHit) {
                console.log(`      [Sub-niche]: low-confidence ${bestSub} hit (${subMatches[bestSub].join(', ')}) not strong enough to override AI-theme ${directSub}`);
                return directSub;
            }
            console.log(`      [Sub-niche override]: ${bestSub}(${bestScore}) wins — AI-theme ${directSub} scored 0 keywords`);
            return bestSub;
        }

        if (!bestSub || bestSub === directSub || (diff < 2 && ratio < 2)) {
            if (bestSub && bestSub !== directSub) {
                console.log(`      [Sub-niche]: keyword winner ${bestSub}(${bestScore}) not strong enough to override AI-theme ${directSub}(${directScore}) — need higher ratio or gap`);
            }
            return directSub;
        }
        // Keyword winner is significantly stronger — override AI theme
        console.log(`      [Sub-niche override]: ${bestSub}(${bestScore}) beats AI-theme ${directSub}(${directScore}) [diff=${diff}, ratio=${ratio.toFixed(1)}x]`);
    }

    if (!directSub && weakBestSubSingleHit) {
        console.log(`      [Sub-niche]: low-confidence ${bestSub} hit (${subMatches[bestSub].join(', ')}) not strong enough to specialize parent ${parentId}`);
        return null;
    }

    return bestSub; // null if no sub-niche scored high enough
}

// Global confidence guard: any sub-niche can still win on a strong single
// identity term (murder, election, missile, IPO, wildlife, etc.), but one
// generic single-word hit should not specialize the whole video by itself.
const LOW_CONFIDENCE_SINGLE_KEYWORDS = new Set([
    // Nature / environment words that often appear in policy, science, or metaphor.
    'environment', 'climate', 'earth', 'plant', 'bird', 'marine', 'weather',

    // Crime / investigation words that appear outside true-crime content.
    'investigation', 'mystery', 'thriller', 'evidence', 'court', 'trial', 'victim',

    // Business / economy words that are often secondary impact, not the topic.
    'economy', 'market', 'stock', 'trade', 'export', 'import', 'currency',
    'dollar', 'debt', 'earnings', 'startup',

    // Luxury / lifestyle words that caused the China-car style of misroute.
    'beauty', 'style', 'elegant', 'premium', 'designer', 'wedding', 'art',
    'exclusive', 'boutique', 'lifestyle',

    // Sports words that collide with games, teams, seasons, scores, and strategy.
    'game', 'team', 'player', 'competition', 'score', 'season', 'match',
    'action', 'champion',

    // Celebrity / entertainment words that are broad or platform-shaped.
    'star', 'famous', 'scandal', 'divorce', 'dating', 'album', 'tour',
    'award', 'nomination', 'instagram', 'tiktok', 'viral',

    // Tech words that are often generic release/process vocabulary.
    'hack', 'digital', 'code', 'data', 'app', 'cloud', 'launch',
    'release', 'update', 'patch',

    // History words that can be context, not the video's subject.
    'history', 'historical', 'century', 'era', 'monument', 'artifact', 'biography', 'archival',

    // Motivation words that are frequently general tone or outcome language.
    'success', 'mindset', 'discipline', 'grind', 'hustle', 'habit',
    'productivity', 'growth', 'confidence', 'goal', 'dream', 'overcome',
    'achieve',

    // Food / health words that often appear in policy, product, or wellness sidebars.
    'diet', 'health', 'ingredient', 'organic', 'meal', 'restaurant',
    'wellness', 'detox', 'gut', 'kitchen', 'grocery',

    // DIY words that collide with generic advice, engineering, and software fixes.
    'trick', 'tip', 'homemade', 'craft', 'repair', 'fix', 'build',
    'project', 'cleaning', 'organize', 'garden', 'tool', 'tutorial',

    // Politics words that are too broad alone.
    'government', 'policy', 'law', 'vote', 'campaign', 'scenario',
    'speculative',
]);

function _isWeakSubNicheSingleHit(subId, matches = []) {
    if (!subId || !Array.isArray(matches) || matches.length !== 1) return false;
    const keyword = _normalizeMatchedKeyword(matches[0]);
    if (!keyword || _isSpecificPhraseKeyword(keyword)) return false;
    return LOW_CONFIDENCE_SINGLE_KEYWORDS.has(keyword);
}

function _normalizeMatchedKeyword(keyword) {
    return String(keyword || '').trim().toLowerCase();
}

function _isSpecificPhraseKeyword(keyword) {
    return /[\s-]/.test(keyword);
}

// ============================================================
// SEARCH POLICY — QUERY REWRITING
// ============================================================

// Providers where queries should be kept short (stock footage APIs)
const STOCK_PROVIDERS = new Set(['pexels', 'pixabay']);
const FREE_STOCK_PROVIDERS = ['pexels', 'pixabay'];

// Providers where context-enriched queries work better (web search) — none active
const WEB_PROVIDERS = new Set();

// YouTube needs specific event/topic queries — not too short (stock-style) or too long (web-style)
const YOUTUBE_PROVIDERS = new Set(['youtube']);

/**
 * Get the keyword formation rules for a niche (with safe defaults).
 * @param {string} nicheId
 * @returns {Object} keywordRules
 */
function getKeywordRules(nicheId) {
    const niche = getNiche(nicheId);
    return niche.keywordRules || NICHES.general.keywordRules;
}

/**
 * Get the search policy for a niche (with safe defaults).
 * @param {string} nicheId
 * @returns {Object} searchPolicy
 */
function getSearchPolicy(nicheId) {
    const niche = getNiche(nicheId);
    return niche.searchPolicy || NICHES.general.searchPolicy;
}

/**
 * Rewrite a search query based on niche search policy and provider type.
 *
 * For stock providers (Pexels/Pixabay):
 *   - Truncate to stockMaxWords
 *   - Strip avoid terms
 *   - Keep entity names if entityBoost is on
 *
 * @param {string} keyword - Original keyword from AI visual planner
 * @param {string} nicheId - Active niche ID
 * @param {string} providerKey - Provider key (e.g., 'storyblocks')
 * @param {Object} [scene] - Optional scene object for entity extraction
 * @returns {string} Rewritten query
 */
function rewriteQuery(keyword, nicheId, providerKey, scene) {
    if (!keyword || !keyword.trim()) return keyword;

    const policy = getSearchPolicy(nicheId);
    let query = keyword.trim();

    // Step 0: Strip wrapping quotes (AI sometimes wraps queries in quotes)
    query = query.replace(/^["']+|["']+$/g, '');

    // Step 1: Strip avoid terms
    if (policy.avoidTerms && policy.avoidTerms.length > 0) {
        for (const term of policy.avoidTerms) {
            // Case-insensitive word boundary replacement
            const regex = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
            query = query.replace(regex, '');
        }
        query = query.replace(/\s{2,}/g, ' ').trim();
    }

    // Step 2: Provider-specific rewriting
    if (STOCK_PROVIDERS.has(providerKey)) {
        // Stock providers: shorter queries = better results
        // Smart word selection: prefer visual/descriptive words over generic ones
        const maxWords = policy.stockMaxWords || 3;
        const words = query.split(/\s+/);
        if (words.length > maxWords) {
            // Words to deprioritize (not useful for stock search)
            const WEAK_WORDS = new Set([
                'photo', 'photos', 'image', 'images', 'footage', 'video', 'clip',
                'real', 'actual', 'showing', 'featuring', 'scene', 'shot', 'view',
                'press', 'conference', 'report', 'event', 'moment', 'latest',
                'new', 'old', 'big', 'small', 'very', 'more', 'most', 'just',
                'about', 'like', 'near', 'around', 'during', 'after', 'before',
                'diagram', 'chart', 'infographic', 'illustration', 'schematic', 'portrait', 'picture',
            ]);

            if (policy.entityBoost && scene && scene.entities && scene.entities.length > 0) {
                const entityWords = scene.entities.join(' ').toLowerCase().split(/\s+/);
                const entityKept = [];
                const otherWords = [];
                for (const w of words) {
                    if (entityWords.includes(w.toLowerCase())) {
                        entityKept.push(w);
                    } else {
                        otherWords.push(w);
                    }
                }
                const remaining = maxWords - entityKept.length;
                query = [...entityKept, ...otherWords.slice(0, Math.max(1, remaining))].join(' ');
            } else {
                // Score each word: longer words and visual descriptors score higher
                const scored = words.map(w => ({
                    word: w,
                    score: (WEAK_WORDS.has(w.toLowerCase()) ? -5 : 0) + w.length
                }));
                // Sort by score descending, take top N, then restore original order
                const topN = scored
                    .map((s, idx) => ({ ...s, idx }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, maxWords)
                    .sort((a, b) => a.idx - b.idx);
                query = topN.map(s => s.word).join(' ');
            }
        }
    } else if (YOUTUBE_PROVIDERS.has(providerKey)) {
        // YouTube: 3-6 words, event/topic focused, add "footage" or "video" if missing
        // Strip weak filler words but keep entity names and action words
        const YOUTUBE_STRIP = new Set([
            'photo', 'photos', 'image', 'images', 'portrait', 'picture',
            'diagram', 'chart', 'infographic', 'illustration', 'schematic',
            'showing', 'featuring', 'real', 'actual',
        ]);
        // Words that name a KIND OF EXPLANATION rather than a non-video medium.
        // A scene whose own brief asks for a cutaway is searching for exactly
        // these, and deleting them is how the Jul-29 build searched for a heat
        // exchanger when the scene needed a heat-exchanger DIAGRAM and shipped
        // with no media. The decision comes from the scene's Media Hunter
        // profile (media/packaging-intent.js) — no niche is named here, and with
        // no profile attached the behaviour is byte-identical to before.
        const KEEP_IF_REQUESTED = new Set([
            'diagram', 'chart', 'infographic', 'illustration', 'schematic',
        ]);
        const wantsGraphic = !!scene?._mediaHunterProfile?.requestedPackaging?.graphic;
        const words = query.split(/\s+/).filter((w) => {
            const lw = w.toLowerCase();
            if (!YOUTUBE_STRIP.has(lw)) return true;
            return wantsGraphic && KEEP_IF_REQUESTED.has(lw);
        });
        // Target 3-6 words for YouTube search
        if (words.length > 6) {
            query = words.slice(0, 6).join(' ');
        } else {
            query = words.join(' ');
        }
        // Add "footage" if query is very short and doesn't have a video-related word
        const lower = query.toLowerCase();
        if (words.length <= 2 && !lower.includes('footage') && !lower.includes('video') && !lower.includes('clip')) {
            query = query + ' footage';
        }
    } else if (WEB_PROVIDERS.has(providerKey)) {
        // Web/news providers: strip image-only words that hurt video search
        const WEB_STRIP = new Set([
            'diagram', 'chart', 'infographic', 'illustration', 'schematic',
            'photo', 'photos', 'image', 'images', 'portrait', 'picture',
        ]);
        const webWords = query.split(/\s+/).filter(w => !WEB_STRIP.has(w.toLowerCase()));
        if (webWords.length > 0) query = webWords.join(' ');

        // Only add context term if query is short/generic (≤3 words)
        // The Visual Planner already generates 4-8 word specific queries — don't bloat them
        const wordCount = query.split(/\s+/).length;
        if (wordCount <= 3 && policy.contextTerms && policy.contextTerms.length > 0) {
            const lowerQuery = query.toLowerCase();
            for (const term of policy.contextTerms) {
                if (!lowerQuery.includes(term.toLowerCase())) {
                    query = query + ' ' + term;
                    break;
                }
            }
        }
    }

    // Step 2.5: Append negative-search operators for providers that support
    // them (YouTube/Reddit/web all honor `-term`). When the query contains an
    // ambiguous geographic token like "Red Sea" / "Persian Gulf", inject
    // niche.avoidTerms as `-term` so the engine filters tourism/diving/fiction
    // content at the source instead of relying on post-filter Title Sanity
    // rejecting every result.
    const supportsNegation = YOUTUBE_PROVIDERS.has(providerKey)
        || providerKey === 'reddit'
        || WEB_PROVIDERS.has(providerKey);
    if (supportsNegation && policy.avoidTerms && policy.avoidTerms.length > 0 && _hasAmbiguousGeoToken(query)) {
        const lowerQuery = query.toLowerCase();
        const negations = [];
        for (const term of policy.avoidTerms) {
            const t = String(term || '').trim();
            if (!t || t.length < 3) continue;
            if (lowerQuery.includes(t.toLowerCase())) continue;
            // Quote multi-word negations so the engine treats them as a phrase.
            const negToken = /\s/.test(t) ? `-"${t}"` : `-${t}`;
            negations.push(negToken);
            if (negations.length >= 4) break; // cap to avoid query bloat
        }
        if (negations.length) {
            query = `${query} ${negations.join(' ')}`;
        }
    }

    // Step 3: Final cleanup
    query = query.replace(/\s{2,}/g, ' ').trim();

    return query || keyword.trim(); // Never return empty
}

// Ambiguous geographic tokens — when present, the literal place name will
// fetch tourism/diving/recreation content without explicit niche-context
// disambiguation. Trigger negation injection only for these queries to avoid
// bloating every search with -cartoon -game -movie.
const _AMBIGUOUS_GEO_TOKEN_RE = /\b(sea|gulf|strait|canal|bay|coast|coastline|shore|ocean|harbor|harbour|river|delta|island|cape|peninsula|reef|lagoon)\b/i;

function _hasAmbiguousGeoToken(query) {
    return _AMBIGUOUS_GEO_TOKEN_RE.test(String(query || ''));
}

/**
 * Get niche-specific fallback keywords for when all provider searches fail.
 * @param {string} nicheId
 * @returns {string[]}
 */
function getFallbackKeywords(nicheId) {
    const policy = getSearchPolicy(nicheId);
    return policy.fallbackKeywords || NICHES.general.searchPolicy.fallbackKeywords;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Category-level provider exclusions for ALL explainer niches. Currently empty
// — individual explainer niches can still opt-out specific providers via their
// own `excludeVideoProviders` field if needed.
const EXPLAINER_EXCLUDED_PROVIDERS = [];
const GLOBAL_DISABLED_VIDEO_PROVIDERS = [...DISABLED_VIDEO_PROVIDER_KEYS];

function _withoutGlobalDisabledVideoProviders(niche) {
    if (!niche) return niche;
    const disabled = new Set(GLOBAL_DISABLED_VIDEO_PROVIDERS);
    const next = { ...niche };
    const normalizePriority = (values = []) => {
        const out = [];
        const seen = new Set();
        for (const value of values) {
            const key = String(value || '').trim().toLowerCase();
            const hint = sanitizeSourceHint(key, '') || key;
            const replacements = key === 'storyblocks' || hint === 'stock'
                ? FREE_STOCK_PROVIDERS
                : [value];
            for (const replacement of replacements) {
                const clean = String(replacement || '').trim().toLowerCase();
                if (!clean || disabled.has(clean) || seen.has(clean)) continue;
                seen.add(clean);
                out.push(clean);
            }
        }
        return filterDisabledSources(out).filter(p => !disabled.has(p));
    };
    if (next.footagePriority?.video) {
        next.footagePriority = {
            ...next.footagePriority,
            video: normalizePriority(next.footagePriority.video),
        };
    }
    if (next.footagePriority?.image) {
        next.footagePriority = {
            ...next.footagePriority,
            image: normalizePriority(next.footagePriority.image),
        };
    }
    if (next.treatmentOverrides && typeof next.treatmentOverrides === 'object') {
        next.treatmentOverrides = Object.fromEntries(Object.entries(next.treatmentOverrides).map(([key, value]) => [
            key,
            value && typeof value === 'object'
                ? { ...value, preferredSource: sanitizeSourceHint(value.preferredSource, 'youtube') || value.preferredSource }
                : value,
        ]));
    }
    const excluded = new Set(next.excludeVideoProviders || []);
    GLOBAL_DISABLED_VIDEO_PROVIDERS.forEach(p => excluded.add(p));
    next.excludeVideoProviders = [...excluded];
    return next;
}

// All overlay MG types available in the system (from mg-registry.js).
// Explainer category gets the full set — rich visual treatment.
const ALL_OVERLAY_MGS = [
    'headline', 'lowerThird', 'callout', 'statCounter', 'focusWord',
    'progressBar', 'barChart', 'donutChart', 'rankingList', 'timeline',
    'comparisonCard', 'bulletList', 'mapChart', 'explainer', 'kineticText', 'typewriter',
];

// Breaking news category: footage-first. Only minimal text overlays that don't compete
// with the raw footage. 4 types: identity bar, typed text, callout bubble, live stat.
const NEWS_OVERLAY_MGS = ['lowerThird', 'typewriter', 'callout', 'statCounter'];

/**
 * Get niche object by ID. Supports sub-niches (e.g., 'news.politics').
 * Sub-niches merge: parent fields as base, sub-niche fields override.
 *
 * Rule enforced here: globally-disabled video providers are filtered out of
 * every niche's footagePriority and added to excludeVideoProviders.
 *
 * @param {string} nicheId - e.g., 'news', 'news.politics', 'explainer.crime'
 * @returns {Object} Niche config (merged if sub-niche)
 */
function getNiche(nicheId) {
    // Direct match (including sub-niche entries like 'news.politics')
    if (NICHES[nicheId]) {
        const niche = NICHES[nicheId];
        let resolved;
        // If it has a _parent, merge with parent
        if (niche._parent) {
            const parent = NICHES[niche._parent] || NICHES.general;
            resolved = _mergeNiche(parent, niche);
        } else {
            resolved = niche;
        }
        // Enforce category-level rules at resolution time
        const isExplainerCategory = resolved.id === 'explainer' || resolved._parentId === 'explainer';
        const isNewsCategory      = resolved.id === 'news'      || resolved._parentId === 'news';

        if (isExplainerCategory) {
            // Explainer: rich MG treatment by default, but allow sub-niches to
            // narrow the overlay list explicitly (for example politics).
            const excluded = new Set(resolved.excludeVideoProviders || []);
            EXPLAINER_EXCLUDED_PROVIDERS.forEach(p => excluded.add(p));
            const nextResolved = { ...resolved, excludeVideoProviders: [...excluded] };
            if (!niche.allowedMGs) {
                nextResolved.allowedMGs = ALL_OVERLAY_MGS;
            }
            resolved = nextResolved;
        } else if (isNewsCategory) {
            // News: footage-first, only minimal overlay MGs.
            // Sub-niches can define their own allowedMGs (e.g. news.military adds mapChart).
            // Only apply the category default if the sub-niche didn't specify its own list.
            if (!niche.allowedMGs) {
                resolved = { ...resolved, allowedMGs: NEWS_OVERLAY_MGS };
            }
        }

        return _withoutGlobalDisabledVideoProviders(resolved);
    }
    return _withoutGlobalDisabledVideoProviders(NICHES.general);
}

/**
 * Merge parent niche with sub-niche overrides.
 * Sub-niche fields win; missing fields fall back to parent.
 */
function _mergeNiche(parent, sub) {
    return {
        ...parent,
        ...sub,
        // Keep parent's defaultTheme/defaultPacing unless sub explicitly overrides
        defaultTheme: sub.defaultTheme || parent.defaultTheme,
        defaultPacing: sub.defaultPacing || parent.defaultPacing,
        // Sub-niche overlayPrefs merge with parent's
        overlayPrefs: sub.overlayPrefs ? { ...parent.overlayPrefs, ...sub.overlayPrefs } : parent.overlayPrefs,
        // Mark as resolved sub-niche
        _resolved: true,
        _parentId: parent.id,
    };
}

/**
 * Get all niche IDs
 * @returns {Array<string>}
 */
function getNicheIds() {
    return Object.keys(NICHES);
}

/**
 * Get all niches for UI
 * @returns {Array<Object>}
 */
function getAllNiches() {
    return Object.values(NICHES).map(n => ({
        id: n.id,
        name: n.name,
        description: n.description,
        defaultTheme: n.defaultTheme
    }));
}

// ============================================================
// NICHE PRESETS — User-facing presets for the UI dropdown
// ============================================================

/**
 * Each preset maps to a niche ID and optionally suggests a format and pacing.
 * The UI dropdown uses these; when selected, the preset locks the niche
 * deterministically and provides downstream hints.
 *
 * - nicheId: which NICHES entry to use (drives MGs, footage, search policy)
 * - suggestedFormat: hint for BUILD_FORMAT (null = don't override user's choice)
 * - suggestedPacing: hint for scene density (null = use niche default)
 * - label: user-facing dropdown label
 * - emoji: icon for dropdown
 */
const NICHE_PRESETS = {
    // ── Auto ──
    auto:           { nicheId: null,                  suggestedFormat: null,           suggestedPacing: null,       label: 'Auto-Detect',             emoji: '🤖' },
    // ── Explainer / Documentary category ──
    explainer:      { nicheId: 'explainer',           suggestedFormat: 'documentary',  suggestedPacing: 'moderate', label: 'Explainer / Documentary',  emoji: '📽️' },
    trueCrime:      { nicheId: 'explainer.crime',     suggestedFormat: 'documentary',  suggestedPacing: 'moderate', label: 'True Crime Documentary',   emoji: '🔪' },
    documentary:    { nicheId: 'explainer.nature',    suggestedFormat: 'documentary',  suggestedPacing: 'slow',     label: 'Nature Documentary',       emoji: '🎬' },
    finance:        { nicheId: 'explainer.business',  suggestedFormat: null,           suggestedPacing: 'moderate', label: 'Finance / Business',       emoji: '💰' },
    luxury:         { nicheId: 'explainer.luxury',    suggestedFormat: null,           suggestedPacing: 'slow',     label: 'Luxury / Fashion',         emoji: '💎' },
    sports:         { nicheId: 'explainer.sport',     suggestedFormat: null,           suggestedPacing: 'fast',     label: 'Sports Documentary',       emoji: '⚽' },
    history:        { nicheId: 'explainer.history',   suggestedFormat: 'documentary',  suggestedPacing: 'slow',     label: 'History Documentary',      emoji: '📜' },
    motivation:     { nicheId: 'explainer.motivation',suggestedFormat: null,           suggestedPacing: 'moderate', label: 'Motivation',               emoji: '🔥' },
    food:           { nicheId: 'explainer.food',      suggestedFormat: null,           suggestedPacing: 'moderate', label: 'Food / Health',            emoji: '🍎' },
    diy:            { nicheId: 'explainer.diy',       suggestedFormat: null,           suggestedPacing: 'moderate', label: 'DIY / Lifehacks',          emoji: '🔧' },
    militaryDoc:    { nicheId: 'explainer.military',  suggestedFormat: 'documentary',  suggestedPacing: 'moderate', label: 'Military Documentary',     emoji: '🪖' },
    politicsDoc:    { nicheId: 'explainer.politics',  suggestedFormat: 'documentary',  suggestedPacing: 'moderate', label: 'Politics Explainer',       emoji: '🏛' },
    techExplainer:  { nicheId: 'explainer.tech',      suggestedFormat: 'documentary',  suggestedPacing: 'moderate', label: 'Tech Explainer',           emoji: '🔬' },
    // ── Breaking News category ──
    news:           { nicheId: 'news',                suggestedFormat: null,           suggestedPacing: 'fast',     label: 'News (Auto)',              emoji: '📰' },
    newsPolitics:   { nicheId: 'news.politics',       suggestedFormat: null,           suggestedPacing: 'fast',     label: 'News / Politics',          emoji: '🏛️' },
    newsEconomy:    { nicheId: 'news.economy',        suggestedFormat: null,           suggestedPacing: 'fast',     label: 'News / Economy',           emoji: '📈' },
    military:       { nicheId: 'news.military',       suggestedFormat: null,           suggestedPacing: 'moderate', label: 'Military / Geopolitics',   emoji: '🎖️' },
    newsCelebrity:  { nicheId: 'news.celebrity',      suggestedFormat: null,           suggestedPacing: 'fast',     label: 'News / Celebrity',         emoji: '⭐' },
    tech:           { nicheId: 'news.tech',           suggestedFormat: null,           suggestedPacing: 'fast',     label: 'Tech News',                emoji: '💻' },
    newsSport:      { nicheId: 'news.sport',          suggestedFormat: null,           suggestedPacing: 'fast',     label: 'Sports News',              emoji: '🏆' },
};

/**
 * Get all presets for UI rendering.
 * @returns {Array<{key: string, label: string, emoji: string}>}
 */
function getPresets() {
    return Object.entries(NICHE_PRESETS).map(([key, p]) => ({
        key,
        label: p.label,
        emoji: p.emoji,
        nicheId: p.nicheId
    }));
}

/**
 * Resolve a preset key to its niche + hints.
 * Returns null fields for 'auto' (AI decides).
 * @param {string} presetKey
 * @returns {Object}
 */
function resolvePreset(presetKey) {
    const preset = NICHE_PRESETS[presetKey];
    if (!preset || !preset.nicheId) {
        return { nicheId: null, suggestedFormat: null, suggestedPacing: null };
    }
    return {
        nicheId: preset.nicheId,
        suggestedFormat: preset.suggestedFormat,
        suggestedPacing: preset.suggestedPacing
    };
}

// NOTE: listicleGrid removed from MG system — now handled by ai-templates.js (Step 6.5)
// listicleCounter is added dynamically only when format is 'listicle' (see build-video.js)
// Do NOT force-inject listicle MG types into all niches — they're format-specific.

// ── Default template settings for all niches ──
// Per-niche template type allowlist and density (max count).
// Niches can override these by defining allowedTemplates/templateDensity explicitly.
const DEFAULT_ALLOWED_TEMPLATES = ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'timelineCard', 'factCard', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen', 'infographic'];
const NICHE_TEMPLATE_CONFIG = {
    // EXPLAINER parent + all sub-niches: rich visual treatment
    explainer:               { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    'explainer.nature':      { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'factCard', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen'],                  density: 'medium' },
    'explainer.crime':       { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    'explainer.business':    { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    'explainer.luxury':      { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen'],                           density: 'medium' },
    'explainer.sport':       { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'factCard', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen'],            density: 'medium' },
    'explainer.history':     { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    'explainer.motivation':  { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen'],                                           density: 'medium' },
    'explainer.food':        { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    'explainer.diy':         { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    'explainer.military':    { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen', 'infographic'], density: 'high' },
    'explainer.politics':    { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen', 'infographic'], density: 'high' },
    'explainer.tech':        { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'high' },
    // NEWS niches: footage-driven, minimal templates
    news:                    { allowed: ['chapterCard', 'locationCard', 'personIntro'],                                                                                                  density: 'low' },
    'news.politics':         { allowed: ['chapterCard', 'locationCard', 'personIntro'],                                                                                                  density: 'low' },
    'news.celebrity':        { allowed: ['personIntro'],                                                                                                                                 density: 'low' },
    'news.economy':          { allowed: ['chapterCard', 'statCard', 'personIntro', 'infographic'],                                                                                        density: 'low' },
    'news.military':         { allowed: ['chapterCard', 'locationCard', 'personIntro', 'splitScreen', 'infographic'],                                                                    density: 'low' },
    'news.tech':             { allowed: ['chapterCard', 'personIntro'],                                                                                                                  density: 'low' },
    'news.sport':            { allowed: ['chapterCard', 'personIntro'],                                                                                                                  density: 'low' },
    general:                 { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                                                       density: 'low' },
};
for (const niche of Object.values(NICHES)) {
    const cfg = NICHE_TEMPLATE_CONFIG[niche.id];
    if (!niche.allowedTemplates) {
        niche.allowedTemplates = cfg ? cfg.allowed : DEFAULT_ALLOWED_TEMPLATES;
    }
    if (!niche.templateDensity) {
        niche.templateDensity = cfg ? cfg.density : 'low';
    }
}

// ============================================================
// SMART SCENE SPLIT CONFIG
// Per-niche duration bands + feature weights for the smart splitter.
// Read by src/scene-optimizer.js and src/scene-boundary-scorer.js.
// ============================================================

// Tuned 2026-04-20: bodyBand lower bound raised from 3.0 → 4.5s after real-data
// validation showed 3-4s body scenes are choppy. Soft-band penalty now kicks in
// below 4.5s, encouraging body spans to breathe.
//
// Refined 2026-04-20 (Phase 2.5): unitThresholds exposed as config so niches can
// tune speech-unit shape. weights rebalanced after zoneAlignment was re-centered
// around 0 (was acting as a cut subsidy floor, not a signal). New topic feature
// adds a lexical Jaccard-based topic-shift contributor.
const DEFAULT_SCENE_SPLIT = {
    hookBand:   [1.8, 4.5],
    bodyBand:   [4.5, 12.0],
    ctaBand:    [5.0, 15.0],
    pauseSensitivity: 1.0,
    // styleBlend controls how much the style-profile avgSceneDuration influences
    // the optimizer's target per zone. 1.0 = style dominates, 0.0 = band midpoint
    // dominates. After blending, the target is CLAMPED into the zone band.
    // Explainer niches set body low (0.15–0.25) so a reference video with
    // aggressive 3s pacing doesn't drag 498s longform scripts into news-rhythm.
    styleBlend: { hook: 0.7, body: 0.5, cta: 0.5 },
    // bandResistance multiplies the under-band penalty in body zone only.
    // 1.0 = default, >1 = push harder against sub-band body spans.
    bandResistance: 1.0,
    // topicGating: when true, topicShift contribution is attenuated in the
    // body zone unless an anchor signal (pause / entity / contrast / numeric /
    // entityType) is also present. Prevents topicShift from solo-driving cuts.
    topicGating: false,
    unitThresholds: {
        minUnitDur:   0.8,   // shortest a speech unit can be before we force absorb
        maxUnitDur:   6.0,   // hard ceiling — unit closes regardless of pause/segment state
        pauseHardSec: 0.8,   // gap large enough to always break
        pauseSoftSec: 0.4,   // gap large enough to break IF unit is ≥ minUnitDur
        entityWindow: 3,     // words on each side checked for entity straddling
    },
    weights: {
        pause:         1.0,
        entity:        0.9,
        entityType:    0.7,
        numeric:       0.5,
        contrast:      0.8,
        pronoun:       0.4,
        // segmentHint DEMOTED 0.3 → 0.15 after Apr 20 real-build showed it was
        // contributing 0.15 avg — louder than pauseScore (0.08). Whisper segment
        // boundaries are an editing artifact, not a narrative cue.
        segmentHint:   0.15,
        zoneAlignment: 1.0,  // weight applies to a CENTERED value in [-0.3, +0.2]
        stylePacing:   0.6,
        // topic weight pulled in from 0.7 default; explainer niches override
        // this further downward to keep topicShift from monopolizing cuts.
        topic:         0.5,
    }
};

// Per-niche deltas. Keys are niche IDs; values are partial objects that
// override only the fields they mention. Anything not listed here inherits
// DEFAULT_SCENE_SPLIT.
const SCENE_SPLIT_OVERRIDES = {
    // NEWS — tighter hook + body, pauses matter more, shorter unit ceiling so
    // rapid-fire cuts aren't starved for candidate units. bodyBand lower raised
    // 2.5 → 3.0 (2.5s body scenes looked like fragments in validation).
    'news':              { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },
    'news.politics':     { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },
    'news.celebrity':    { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },
    'news.military':     { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },
    'news.economy':      { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },
    'news.tech':         { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },
    'news.sport':        { hookBand: [1.5, 3.5], bodyBand: [3.0, 8.0],  pauseSensitivity: 1.3, unitThresholds: { maxUnitDur: 4.5 } },

    // GEOPOLITICAL / MILITARY EXPLAINERS — wider body, entities matter more.
    // bodyBand lower raised 4.0 → 5.5 so political/military scenes hold on one
    // idea long enough to show the subject (actor/policy/location).
    //
    // Apr 20 real-build tuning: 498s script still produced 113 scenes with avg
    // body 3.8s. Root causes:
    //   - topicShift was 55% of total contribution (0.69/1.26) and drove 64/116
    //     chosen cuts solo — one paragraph-level topic change = one cut.
    //   - style profile's 3.0s/scene avg was being used as direct target,
    //     dragging 498s longform into news rhythm.
    //   - speech units averaged 2.6s, giving DP cheap sub-band spans to choose.
    // Response: topic↓0.7→0.35, topicGating on, styleBlend.body↓0.15 (mostly
    // niche), bandResistance=1.6, coarser unitThresholds.
    // Apr 20 third-pass tuning: previous bandResistance=1.6 still left 13/59
    // body scenes under-band on the reference 498s run. Bumped to 2.0
    // (smallest tightening that targets the under-band tail without
    // over-tightening the 7–9s body norm). Added segmentHintMinPause=0.35
    // so Whisper segment boundaries only trigger unit breaks when there's
    // at least 350ms of real silence — explainer narration has a lot of
    // mid-sentence Whisper segments that were driving 75 unit breaks.
    'explainer.politics': {
        bodyBand: [5.5, 14.0],
        pauseSensitivity: 0.8,
        weights: { entity: 1.1, topic: 0.35, segmentHint: 0.10 },
        styleBlend: { hook: 0.6, body: 0.15, cta: 0.5 },
        bandResistance: 2.0,
        topicGating: true,
        unitThresholds: { minUnitDur: 1.4, maxUnitDur: 8.0, pauseSoftSec: 0.6, segmentHintMinPause: 0.35 },
    },
    'explainer.military': {
        bodyBand: [5.5, 14.0],
        pauseSensitivity: 0.8,
        weights: { entity: 1.1, topic: 0.35, segmentHint: 0.10 },
        styleBlend: { hook: 0.6, body: 0.15, cta: 0.5 },
        bandResistance: 2.0,
        topicGating: true,
        unitThresholds: { minUnitDur: 1.4, maxUnitDur: 8.0, pauseSoftSec: 0.6, segmentHintMinPause: 0.35 },
    },

    // DOCUMENTARY EXPLAINERS — let strong visuals breathe (raised 5.0 → 6.0).
    // Wider unit ceiling so long narration sentences can form single units.
    // Same rhythm problem as politics/military — reuse the same anti-fragment
    // knobs but keep pauseSensitivity at 0.7 (these narrators pause naturally).
    'explainer.history':  {
        bodyBand: [6.0, 14.0], pauseSensitivity: 0.7,
        weights: { topic: 0.4, segmentHint: 0.10 },
        styleBlend: { hook: 0.6, body: 0.2, cta: 0.5 },
        bandResistance: 1.7,
        topicGating: true,
        unitThresholds: { minUnitDur: 1.3, maxUnitDur: 7.5, pauseSoftSec: 0.55, segmentHintMinPause: 0.30 },
    },
    'explainer.crime':    {
        bodyBand: [6.0, 14.0], pauseSensitivity: 0.7,
        weights: { topic: 0.4, segmentHint: 0.10 },
        styleBlend: { hook: 0.6, body: 0.2, cta: 0.5 },
        bandResistance: 1.7,
        topicGating: true,
        unitThresholds: { minUnitDur: 1.3, maxUnitDur: 7.5, pauseSoftSec: 0.55, segmentHintMinPause: 0.30 },
    },
    'explainer.nature':   {
        bodyBand: [6.0, 14.0], pauseSensitivity: 0.7,
        weights: { topic: 0.4, segmentHint: 0.10 },
        styleBlend: { hook: 0.6, body: 0.2, cta: 0.5 },
        bandResistance: 1.7,
        topicGating: true,
        unitThresholds: { minUnitDur: 1.3, maxUnitDur: 7.5, pauseSoftSec: 0.55, segmentHintMinPause: 0.30 },
    },
};

function _deepMergeSplit(base, override) {
    if (!override) return base;
    const out = {
        hookBand: (override.hookBand || base.hookBand).slice(),
        bodyBand: (override.bodyBand || base.bodyBand).slice(),
        ctaBand:  (override.ctaBand  || base.ctaBand ).slice(),
        pauseSensitivity: (typeof override.pauseSensitivity === 'number')
            ? override.pauseSensitivity : base.pauseSensitivity,
        bandResistance: (typeof override.bandResistance === 'number')
            ? override.bandResistance : base.bandResistance,
        topicGating: (typeof override.topicGating === 'boolean')
            ? override.topicGating : base.topicGating,
        styleBlend: Object.assign({}, base.styleBlend || {}, override.styleBlend || {}),
        unitThresholds: Object.assign({}, base.unitThresholds, override.unitThresholds || {}),
        weights: Object.assign({}, base.weights, override.weights || {}),
    };
    return out;
}

/**
 * Get the effective scene-split config for a niche id.
 * Missing niche → DEFAULT_SCENE_SPLIT.
 * Missing fields → inherit from DEFAULT_SCENE_SPLIT.
 */
function getNicheSplitConfig(nicheId) {
    const id = String(nicheId || '').trim();
    const override = SCENE_SPLIT_OVERRIDES[id] || null;
    return _deepMergeSplit(DEFAULT_SCENE_SPLIT, override);
}

// ============================================================
// MAP POLICY (Slice 5a) — per-niche overrides for MapScene compilation
// ============================================================
//
// Map policy controls how the compiler clamps subjects and resolves the
// map mode when VP's mapVariant is missing/ambiguous. Global defaults live
// in map-compiler.js (MODE_SUBJECT_CAPS / MODE_MIN_SUBJECTS); this layer
// lets specific niches widen or tighten those caps per mapMode, or set a
// preferred mode order when variant input is unclear.
//
// Shape of a niche override (all fields optional; missing fields inherit
// from DEFAULT_MAP_POLICY):
//   {
//     subjectCaps:    { locator, route, region, comparison }, // max subjects
//     minSubjects:    { locator, route, region, comparison }, // min to compile
//     preferredModes: ['route', 'locator', ...],              // tie-break order
//   }
//
// `preferredModes` only takes effect when the incoming mapVariant is absent
// or unrecognized — a VP-supplied variant (locator | route | regionHighlight
// | comparison) always wins.
const DEFAULT_MAP_POLICY = {
    // route: 3 — lets origin + mid-corridor via + destination survive the
    // cap. "From Shanghai to Rotterdam around Africa" had Rotterdam dropped
    // at cap=2 and rendered as a Shanghai-Africa two-waypoint tour instead
    // of the actual corridor; 3 fixes this for every niche that inherits.
    subjectCaps:    { locator: 3, route: 3, region: 5, comparison: 4 },
    minSubjects:    { locator: 1, route: 2, region: 1, comparison: 2 },
    preferredModes: ['locator', 'region', 'route', 'comparison'],
};

const MAP_POLICY_OVERRIDES = {
    // MILITARY — narration walks through multi-stop routes (troop movements,
    // supply lines, strike corridors). Default route cap of 2 is too tight;
    // bump to 4 so a 3-4 stop advance can render as one continuous map scene
    // instead of two half-routes.
    'news.military':      { subjectCaps: { route: 4 }, preferredModes: ['route', 'locator', 'region', 'comparison'] },
    'explainer.military': { subjectCaps: { route: 4 }, preferredModes: ['route', 'locator', 'region', 'comparison'] },

    // POLITICS — locator-and-comparison dominant (one capital, or two nations
    // in dialogue). Routes are rare; region highlights are rarer still.
    'news.politics':      { preferredModes: ['locator', 'comparison', 'region', 'route'] },
    'explainer.politics': { preferredModes: ['locator', 'comparison', 'region', 'route'] },

    // HISTORY — expeditions, expansions, trade routes all want more stops.
    // Also widen region for empires/territories that sprawl beyond 5 subjects.
    'explainer.history':  { subjectCaps: { route: 5, region: 6 }, preferredModes: ['route', 'region', 'locator', 'comparison'] },

    // CRIME — location-heavy (scene, suspect, victim). Locator dominant;
    // comparison rare but useful (e.g. two cities where the suspect operated).
    'explainer.crime':    { preferredModes: ['locator', 'comparison', 'region', 'route'] },

    // NATURE — habitats/biomes/migration ranges → region dominant with a
    // wider cap so multi-biome/multi-range surveys fit one frame.
    'explainer.nature':   { subjectCaps: { region: 7 }, preferredModes: ['region', 'locator', 'route', 'comparison'] },

    // ECONOMY — country-pair comparisons dominate (GDP, currency crises,
    // trade imbalances). Comparison first, locator for single-country stories.
    'news.economy':       { preferredModes: ['comparison', 'locator', 'region', 'route'] },
};

function _deepMergeMapPolicy(base, override) {
    const out = {
        subjectCaps:    Object.assign({}, base.subjectCaps),
        minSubjects:    Object.assign({}, base.minSubjects),
        preferredModes: [...base.preferredModes],
    };
    if (!override) return out;
    if (override.subjectCaps)    Object.assign(out.subjectCaps,    override.subjectCaps);
    if (override.minSubjects)    Object.assign(out.minSubjects,    override.minSubjects);
    if (Array.isArray(override.preferredModes) && override.preferredModes.length) {
        out.preferredModes = [...override.preferredModes];
    }
    return out;
}

/**
 * Get the effective map policy for a niche id.
 * Missing niche → DEFAULT_MAP_POLICY.
 * Missing fields in override → inherit from DEFAULT_MAP_POLICY.
 */
function getNicheMapPolicy(nicheId) {
    const id = String(nicheId || '').trim();
    const override = MAP_POLICY_OVERRIDES[id] || null;
    return _deepMergeMapPolicy(DEFAULT_MAP_POLICY, override);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    NICHES,
    NICHE_PRESETS,
    pickNicheFromContent,
    getNiche,
    getNicheIds,
    getAllNiches,
    getPresets,
    resolvePreset,
    getKeywordRules,
    getSearchPolicy,
    rewriteQuery,
    getFallbackKeywords,
    DEFAULT_SCENE_SPLIT,
    SCENE_SPLIT_OVERRIDES,
    getNicheSplitConfig,
    DEFAULT_MAP_POLICY,
    MAP_POLICY_OVERRIDES,
    getNicheMapPolicy,
};
