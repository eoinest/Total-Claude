#!/usr/bin/env node
/**
 * fetch-assets.mjs -- reproducible, integrity-checked asset fetcher for Total-Claude.
 *
 * Downloads the exact CC0 asset set documented in ASSETS.md. Node builtins only.
 *
 *   node tools/fetch-assets.mjs              # fetch missing / repair mismatched
 *   node tools/fetch-assets.mjs --verify     # verify on-disk files, download nothing
 *   node tools/fetch-assets.mjs --force      # re-download everything
 *   node tools/fetch-assets.mjs --print-hashes   # emit the SHA-256 table (for bootstrap)
 *
 * Safety properties enforced here (mirrors the manual checks in ASSETS.md):
 *   1. Host allowlist  -- only dl.polyhaven.org / drive.google.com (Quaternius' own
 *      distribution folders, which quaternius.com's download buttons point at).
 *   2. Extension allowlist -- refuses to write anything outside a known-safe media set.
 *   3. Magic-byte sniffing -- the payload must actually look like the declared format.
 *      An HTML error/interstitial page saved as ".jpg" is rejected, not written.
 *   4. SHA-256 pinning -- every byte is compared against the inlined manifest before
 *      the temp file is promoted into public/assets. Mismatch => discarded.
 *   5. No archive extraction, no execution, ever. Nothing in this set is an archive.
 */

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const ASSETS = [
  // ---- Poly Haven HDRIs (CC0) -- 2K equirectangular Radiance .hdr ----
  { p: "assets/hdri/midday-partly-cloudy-2k.hdr", u: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr", h: '5244534e9cf5b606f2ff513aa00ddb161b0a4826ffd88a0d3bd03ac29247d198' },
  { p: "assets/hdri/golden-hour-sunset-2k.hdr", u: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloppenheim_06_puresky_2k.hdr", h: '99451201586489ef3288c97bfac2a2ac232a5491c51a1faf0ec8ea39f3ccd533' },
  { p: "assets/hdri/overcast-afternoon-2k.hdr", u: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_overcast_puresky_2k.hdr", h: '312b1b04b7f10057a4f1418abc59d1166c8933cc93fc72051502edaf8d6b2fcd' },
  { p: "assets/hdri/dawn-sunrise-2k.hdr", u: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kiara_1_dawn_2k.hdr", h: '7261c613b35a9b760ed5c7846ec8182532b90d89f6a8385c42bb743883159a66' },
  // ---- Poly Haven PBR textures (CC0) -- 2K JPG, OpenGL-convention normals ----
  { p: "assets/textures/roman-travertine-blocks/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_diff_2k.jpg", h: 'da2f453c7c3683f5b01ca8b365ccf81ebce488afab7661adecd83208fc9aec97' },
  { p: "assets/textures/roman-travertine-blocks/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_nor_gl_2k.jpg", h: '735f205de2d44f2e7edddf22d6b7dca5cd2ace000f3f637546302508dd9616c2' },
  { p: "assets/textures/roman-travertine-blocks/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_rough_2k.jpg", h: '676d9f00b54f303dc19856123312110be3859066661b224dececc3bc857c8f21' },
  { p: "assets/textures/roman-travertine-blocks/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sandstone_blocks_08/sandstone_blocks_08_ao_2k.jpg", h: '8c77ecef52727a13a3e6afa731390c37c285692de9703da426402fe1e61b611f' },
  { p: "assets/textures/white-marble/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/marble_01/marble_01_diff_2k.jpg", h: 'd403786171716f86718bdd67eba923d4fb6125c0636bacef0e6a21dd5d623a48' },
  { p: "assets/textures/white-marble/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/marble_01/marble_01_nor_gl_2k.jpg", h: 'd5e17ccb2913adbf28fcb781fddf0aa711259ddea6c1c918442f9a3589aa4660' },
  { p: "assets/textures/white-marble/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/marble_01/marble_01_rough_2k.jpg", h: '1b970e033856c93ee7390d947da5340e101b489fc8c1463354ea9e6655ce039a' },
  { p: "assets/textures/white-marble/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/marble_01/marble_01_ao_2k.jpg", h: 'e0d535b591430f1ebfd8ffa38086949bb074ae470f6fec7f3dcd55f594f52d4e' },
  { p: "assets/textures/limestone-wall-blocks/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/large_sandstone_blocks_01/large_sandstone_blocks_01_diff_2k.jpg", h: '87e5f9404e8aa572d6a21ba86e57a67d17c71e39dfcd9ca0699393a1d116d425' },
  { p: "assets/textures/limestone-wall-blocks/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/large_sandstone_blocks_01/large_sandstone_blocks_01_nor_gl_2k.jpg", h: '10980fa925525e08450779599756b3852370640010b29b59a583609917d92047' },
  { p: "assets/textures/limestone-wall-blocks/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/large_sandstone_blocks_01/large_sandstone_blocks_01_rough_2k.jpg", h: '5e8294a1954d5aec314159822ccb0d06b198784b617511d86ea77f635265c423' },
  { p: "assets/textures/limestone-wall-blocks/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/large_sandstone_blocks_01/large_sandstone_blocks_01_ao_2k.jpg", h: '80ffa0f03d975b36a5d74a46212365a5570fc5b9f75233178aada35e1ead86bf' },
  { p: "assets/textures/terracotta-roof-tiles/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/clay_roof_tiles_02/clay_roof_tiles_02_diff_2k.jpg", h: '570e1878985993bf81433d785b4fa2d4ab9f6d32447706193089b11ff0851731' },
  { p: "assets/textures/terracotta-roof-tiles/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/clay_roof_tiles_02/clay_roof_tiles_02_nor_gl_2k.jpg", h: '762e2f18ba063fe3c587955be9f8a0a6e8e75cee4057e188970d1ec70a880194' },
  { p: "assets/textures/terracotta-roof-tiles/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/clay_roof_tiles_02/clay_roof_tiles_02_rough_2k.jpg", h: 'a70d571203b80f763a6bcd4463330d8e2a5480ee6e29b559d1a05f1a61d5a81e' },
  { p: "assets/textures/terracotta-roof-tiles/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/clay_roof_tiles_02/clay_roof_tiles_02_ao_2k.jpg", h: 'c49e8cc0175ed764ca3e25c4bfeb71184acb80049570959be8def17e271e943e' },
  { p: "assets/textures/painted-plaster/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/painted_plaster_wall/painted_plaster_wall_diff_2k.jpg", h: '6fd812ed8dd5be1873c29aeef38ce9bf1fb30a22c6d4b3a12db725e98c26a1be' },
  { p: "assets/textures/painted-plaster/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/painted_plaster_wall/painted_plaster_wall_nor_gl_2k.jpg", h: '2d601a46ed5ce2af866741c53cafa3cba472620c272e633b6484d4de16a80eb1' },
  { p: "assets/textures/painted-plaster/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/painted_plaster_wall/painted_plaster_wall_rough_2k.jpg", h: '35aad595469533cc3b7cc209cc6c7e065d660211f02c867f4492d3b371b1fee1' },
  { p: "assets/textures/painted-plaster/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/painted_plaster_wall/painted_plaster_wall_ao_2k.jpg", h: '3d89b5ea1f9d93d611ab0015d887b620ec9c6623e19effadba84ee9345c4c6fc' },
  { p: "assets/textures/cobblestone-road/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/cobblestone_floor_08/cobblestone_floor_08_diff_2k.jpg", h: '9aaf7db7f660f03d0c5c129c11e83caa828fb8bca63f8cd5154d450ffc4c340f' },
  { p: "assets/textures/cobblestone-road/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/cobblestone_floor_08/cobblestone_floor_08_nor_gl_2k.jpg", h: '42dd5fc2da4a858f9c076c9ac5002857a1c064f8f4c4ffb12fafecffb84e96cc' },
  { p: "assets/textures/cobblestone-road/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/cobblestone_floor_08/cobblestone_floor_08_rough_2k.jpg", h: '3bc645ec45543c704fe1042f7b81f9bad4f88a8567760c4898c82bc2a134e093' },
  { p: "assets/textures/cobblestone-road/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/cobblestone_floor_08/cobblestone_floor_08_ao_2k.jpg", h: 'f409fa52dceac782dcb625af914fd592105595749651f396547e8355867b6a5c' },
  { p: "assets/textures/cobblestone-road/displacement.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/cobblestone_floor_08/cobblestone_floor_08_disp_2k.jpg", h: '503cf1444d98526e4105b065112c36258c0063e0fa0a86c573c29f45eecebe88' },
  { p: "assets/textures/dry-grass/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/withered_grass/withered_grass_diff_2k.jpg", h: '0cf0fca68cbf4277199a2b9b7b3a8013357e4087247b1367f86d4a53b4fafa7e' },
  { p: "assets/textures/dry-grass/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/withered_grass/withered_grass_nor_gl_2k.jpg", h: '5fd42baf06224086cb9afcb2f7a3b9f26feddd719bf1f9aed65ec49c586e7ff9' },
  { p: "assets/textures/dry-grass/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/withered_grass/withered_grass_rough_2k.jpg", h: '86adb8d6f24d0a38eb96c6b625f2dd027b805f59af46fe2a05ffe29f633e33c8' },
  { p: "assets/textures/dry-grass/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/withered_grass/withered_grass_ao_2k.jpg", h: 'b91ec4cab6fdd8034c928647a4ad9a09a5b99744db8d18c0743ead407c8d1b93' },
  { p: "assets/textures/dry-grass/displacement.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/withered_grass/withered_grass_disp_2k.jpg", h: '2e9ade0a66c6d6b9990ce19ead20b155e1aed7969e4e86f8210fc7595dd2983d' },
  { p: "assets/textures/meadow-grass/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_diff_2k.jpg", h: '8e1c6d21365d4b89bc5a35ab664da98a78dbc3ab9ba6100474881c8619a5b113' },
  { p: "assets/textures/meadow-grass/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_nor_gl_2k.jpg", h: 'df0cf0ce96e653f033e5b934d5b12995464bda027aa53bd12e329be889aa9f45' },
  { p: "assets/textures/meadow-grass/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_rough_2k.jpg", h: '34e1733bf4064b6950a575ff57e78c8b7ff71b63749eb48a49221bd65de6fb4f' },
  { p: "assets/textures/meadow-grass/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_ao_2k.jpg", h: 'bcce4368f6a1affe11b4a643e14cfed7dfb46abf6bb9e6a28a3b87c2de2ddb11' },
  { p: "assets/textures/meadow-grass/displacement.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_disp_2k.jpg", h: 'de34be0f135a3c92fe6e55cca9501a4cc40e02e84de9cc4c7fefded1da5bd3f3' },
  { p: "assets/textures/mud/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_mud_03/brown_mud_03_diff_2k.jpg", h: '57a87dae26769677578ab53b8829fe9b1e4dfec1ae1726f2942ce99fc73f400b' },
  { p: "assets/textures/mud/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_mud_03/brown_mud_03_nor_gl_2k.jpg", h: '4d9ea1c9321618dbde7bdb2287fae85b646e4bd7b27c294a3475096d30b33880' },
  { p: "assets/textures/mud/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_mud_03/brown_mud_03_rough_2k.jpg", h: 'd4beda6f00e1d0bd431360037569cb7807c38a4f3a5102c256f3c24a4bc0e860' },
  { p: "assets/textures/mud/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_mud_03/brown_mud_03_ao_2k.jpg", h: '4ac0ed146a261a00fb6007844841395962304b7382e37c7ed2ca90d1b184d4a4' },
  { p: "assets/textures/mud/displacement.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_mud_03/brown_mud_03_disp_2k.jpg", h: '295bc090d6c436a84fa2e3402f37b8637ea5c6478b71f6fe892d237ab33cd2f4' },
  { p: "assets/textures/dirt-gravel/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/gravelly_sand/gravelly_sand_diff_2k.jpg", h: 'cdab7130a67bc70f8c241b9ab2cd41b731d2baf1ec533939a333573b80070dd6' },
  { p: "assets/textures/dirt-gravel/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/gravelly_sand/gravelly_sand_nor_gl_2k.jpg", h: '191985454de9403961aab2a6ffd33b6ca1e4c2715712e03f3c928a8140322719' },
  { p: "assets/textures/dirt-gravel/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/gravelly_sand/gravelly_sand_rough_2k.jpg", h: 'da39087ed3beced52f7ca68f77610ecaa048113c33e49a47cb6e7d930733fcaa' },
  { p: "assets/textures/dirt-gravel/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/gravelly_sand/gravelly_sand_ao_2k.jpg", h: 'e98b986061c0919cb09cf7494cf142094c602690e496752cc2a876b3f0a32a71' },
  { p: "assets/textures/dirt-gravel/displacement.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/gravelly_sand/gravelly_sand_disp_2k.jpg", h: '1708db581f6a915b25af3711a923e4b7e7da79ba0828f113797e42d4bd308a08' },
  { p: "assets/textures/sand/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sand_01/sand_01_diff_2k.jpg", h: 'f311767ab68e132cb9de4160493a71ff17ec765c699d411facd5154d9a9a9c18' },
  { p: "assets/textures/sand/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sand_01/sand_01_nor_gl_2k.jpg", h: 'b784b6a0526b79c81635bf423be9bc517ad36278ae5d68a4ff30f46eac56f0e3' },
  { p: "assets/textures/sand/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sand_01/sand_01_rough_2k.jpg", h: '60ec73993d245be5dab83f9debb67cab4303a0af9d4cec3f28868a58f939f8db' },
  { p: "assets/textures/sand/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sand_01/sand_01_ao_2k.jpg", h: '869cb6a93c2fb37fbe37236b33e386871134a5b154354396c7ba000f1be09b22' },
  { p: "assets/textures/sand/displacement.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sand_01/sand_01_disp_2k.jpg", h: '3edaf84b5075600a0c26665d69e4c45dc8bf9df045f126fd18686d0688448a5f' },
  { p: "assets/textures/weathered-wood-planks/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/weathered_brown_planks/weathered_brown_planks_diff_2k.jpg", h: '070ebc4c56a6729ca73a791f7cd3bab7670eb03bfa9ac0218864a554228bcc30' },
  { p: "assets/textures/weathered-wood-planks/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/weathered_brown_planks/weathered_brown_planks_nor_gl_2k.jpg", h: '1c4882afd62de8da66b6e0730894e1a08db1e0cdd2370bd8bce77a6935d8812b' },
  { p: "assets/textures/weathered-wood-planks/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/weathered_brown_planks/weathered_brown_planks_rough_2k.jpg", h: '6897855d0e2758b612fd8cf478aed01b4992d856987a8b4951e5758a48003df2' },
  { p: "assets/textures/weathered-wood-planks/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/weathered_brown_planks/weathered_brown_planks_ao_2k.jpg", h: '69d2aa676f199365dd63253b36db7e1ac78eafbb835055528856c9c3d16d3e5f' },
  { p: "assets/textures/worn-iron/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rust_coarse_01/rust_coarse_01_diff_2k.jpg", h: '5b8801674fa53ff1b6f7853300f50aa7a1b31e69278554803bd957fe9fa7e392' },
  { p: "assets/textures/worn-iron/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rust_coarse_01/rust_coarse_01_nor_gl_2k.jpg", h: '495d3c87da059827ffaf49dae59f967cb3e0b187f4426ab0a47088c3fa83e50b' },
  { p: "assets/textures/worn-iron/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rust_coarse_01/rust_coarse_01_rough_2k.jpg", h: '652eaa2e668c4d24b038716e01c460e6614429634f67ddbcd7f9593296a24885' },
  { p: "assets/textures/worn-iron/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rust_coarse_01/rust_coarse_01_ao_2k.jpg", h: '4340b7de13e1690b2132234ec631d9b1166c70ae2c8076b2d32cf51808bad7f5' },
  { p: "assets/textures/steel-plate/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/metal_plate/metal_plate_diff_2k.jpg", h: '864c9a653acd1f5034c9bbe7f955b18cc9687a81bbdfa805e7a2319939676910' },
  { p: "assets/textures/steel-plate/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/metal_plate/metal_plate_nor_gl_2k.jpg", h: '146f8c00874a584bcc4a184643e72f160da2a7568d469198e02b26c9ff93cf43' },
  { p: "assets/textures/steel-plate/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/metal_plate/metal_plate_rough_2k.jpg", h: '3cdc139df4ec5b304dd986278c1fb026c67c42e6623f0ee5caa7f373d51c7bef' },
  { p: "assets/textures/steel-plate/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/metal_plate/metal_plate_ao_2k.jpg", h: '31e586f0bde9f28331077b30495f0f324aa9f91a9d656205d03242d1d3e2e439' },
  { p: "assets/textures/rough-linen/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rough_linen/rough_linen_diff_2k.jpg", h: 'e71016e08dfebea1dd4e8a2a675e3b617a889a782af782f1abb795906f4db1b4' },
  { p: "assets/textures/rough-linen/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rough_linen/rough_linen_nor_gl_2k.jpg", h: 'c5733ad50cfe0f90c546f3d4076590c1c78a4fd1a83c967cc9c92dc8175b99e6' },
  { p: "assets/textures/rough-linen/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rough_linen/rough_linen_rough_2k.jpg", h: '48400d48fa203882bf5d984d5beb2f95edb1550309924601c018f2c4f3f80731' },
  { p: "assets/textures/rough-linen/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/rough_linen/rough_linen_ao_2k.jpg", h: '277399dfd364393c506fb35f7b868a2d3c0c388400439c327829cf787bc7c315' },
  { p: "assets/textures/brown-leather/albedo.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_leather/brown_leather_albedo_2k.jpg", h: 'b0de2403a31efa31e501b0028c0bd8e504d5bd6318f4a5ce90c550c3067f96d8' },
  { p: "assets/textures/brown-leather/normal.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_leather/brown_leather_nor_gl_2k.jpg", h: '3386277290af50b4d464dc9a9f195bbf8dd6f137b9ae0274552397d2f0135c98' },
  { p: "assets/textures/brown-leather/roughness.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_leather/brown_leather_rough_2k.jpg", h: '8a47afca2630310849034fe40ca9497db0956c67c0d933e6efd49d3cd2befe83' },
  { p: "assets/textures/brown-leather/ao.jpg", u: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_leather/brown_leather_ao_2k.jpg", h: '0f1f8753775779d4e25512f4d08aec1e7dbb73b1d0dc98df66af2071fe8bfa77' },
  // ---- Quaternius models (CC0) -- from the author's own Google Drive folders ----
  { p: "assets/models/nature/CommonTree_1.fbx", u: "https://drive.google.com/uc?export=download&id=1pE1bR8JmlaQYQBRUqI0dBT4dD9c88gTt", h: '0b744c9092a09bfb7228d5ecce26c665363e0f22725d3d89e356dc13789498c3' },
  { p: "assets/models/nature/CommonTree_2.fbx", u: "https://drive.google.com/uc?export=download&id=1bElqNfge2HRm_lkVJuy6zlI4-oRa_Zed", h: 'b3ca339781adc90ca0714d5d3fb081e5432f4a0e47f2697b7865a907b39c93cc' },
  { p: "assets/models/nature/CommonTree_3.fbx", u: "https://drive.google.com/uc?export=download&id=1lT-x_DXFNytzcwYo1tWaAbsu98_4BEqm", h: 'c6c09a4d4797d2b0651cdf8e56ea7baecefd8eb4b4a79fc680ef17747c42b70e' },
  { p: "assets/models/nature/CommonTree_4.fbx", u: "https://drive.google.com/uc?export=download&id=1luLlNmewqELI5KLUNaDsyA975-cQZcm1", h: '611134a64de288ba485ba429478978b8572ff9d74e5d1798f7389b4bbacf43d7' },
  { p: "assets/models/nature/CommonTree_5.fbx", u: "https://drive.google.com/uc?export=download&id=1FidpL9AaaA08VWncdpYtbuOZGGJYNs6s", h: '65f4b9dd21c242d311199406afbd7e6e20785cc66c57ee4db76d5a7c38d3dd4a' },
  { p: "assets/models/nature/CommonTree_Dead_1.fbx", u: "https://drive.google.com/uc?export=download&id=1r4p2Kd2FmirfVcGsaedMkNIHf_ZtbEkB", h: 'e8b1abbacb9f77f2535670c64a0ebe1e9526c5e591f1509067794630124f6591' },
  { p: "assets/models/nature/CommonTree_Dead_2.fbx", u: "https://drive.google.com/uc?export=download&id=1AKxuvEkHM8rtJ5Vu_AHVjQ0A5AH5M2S4", h: 'd5c3d823d515cbfddb0305c5046136348d43230bf5bfc1cbf5951f0632a16b00' },
  { p: "assets/models/nature/CommonTree_Dead_3.fbx", u: "https://drive.google.com/uc?export=download&id=1AxqazVPryo7b7woKCHHtn4HqeSJCUAtU", h: '67ca71199a30e8d61b8c1c5094be60dec2cb90c2b597e890d3fc8bfce0343ddd' },
  { p: "assets/models/nature/PineTree_1.fbx", u: "https://drive.google.com/uc?export=download&id=1eu1YyovyMxyEhYcBc02AzvnDALQ4eu9S", h: '5627e2f33577398ea13ab63f4263afb6cdd4839bf6b4e5d288d6174ff2887266' },
  { p: "assets/models/nature/PineTree_2.fbx", u: "https://drive.google.com/uc?export=download&id=1YQzgUUC0wC-RL_cOeqjryBUIMM9pYs-S", h: 'afc20aab8e9c35ea5e5edf1366d312f8f94948f4d00a40445feb9367cd3e06a3' },
  { p: "assets/models/nature/PineTree_3.fbx", u: "https://drive.google.com/uc?export=download&id=1TvganyQCnUFDebzeOjBqhSbqvvlWXqFB", h: 'e4f038ab6bc8390a5a387bc99fb6b917bb93b6d673d1ac8c22a07521300c1ffc' },
  { p: "assets/models/nature/PineTree_4.fbx", u: "https://drive.google.com/uc?export=download&id=1Izl7ZeNAU6YJb9DRZ4yFB49IzAXgCEhn", h: '7451481e4ae14102b01632bd74e04072cf22b9ce84819175e45220e0ac8bda4f' },
  { p: "assets/models/nature/PineTree_5.fbx", u: "https://drive.google.com/uc?export=download&id=1F0KGB6LKT0fxznLDXBBFPznUBIV9Umzm", h: 'f48c82f590fd94e9dd265575232f867963d08e1d57c9b473e4e1e069220e5536' },
  { p: "assets/models/nature/Willow_1.fbx", u: "https://drive.google.com/uc?export=download&id=1rVGQbavMjGV5SuBLp1Tq6_nAQb2eAy_r", h: '4490d814ed6f744e2390e635a1be31faf461806bfb25b0e15a1203cf4660cb60' },
  { p: "assets/models/nature/Willow_2.fbx", u: "https://drive.google.com/uc?export=download&id=1ZQdQtV2omk-r-L0UtlSXhsUmCu9mc6cr", h: '9614a514370a608493aaf2cf04340c57334672804bb06528103ad65dfc73fa3e' },
  { p: "assets/models/nature/Willow_3.fbx", u: "https://drive.google.com/uc?export=download&id=19jnb7K1tmTrEwukSeBDAkxNJ5T-OtIqo", h: '3a29483120f919f803604cbcbb0cad6bdf240e3c012143e56875495662d79a33' },
  { p: "assets/models/nature/PalmTree_1.fbx", u: "https://drive.google.com/uc?export=download&id=12qY-RbSWQwsR9niKOGqtC4duPEXTTWl-", h: 'bcf142d8a1ceae00edcf4036de1b4cdb43239c578bbd693737b9ed5fa8818df6' },
  { p: "assets/models/nature/PalmTree_2.fbx", u: "https://drive.google.com/uc?export=download&id=1OBs01JprllUN0p9Cr3r88LbI6NDsepJn", h: '716e9e71270e56a8d2eeb69e48014a8ae390d20383e5f3b8f2c50a4d1dd4d815' },
  { p: "assets/models/nature/Rock_1.fbx", u: "https://drive.google.com/uc?export=download&id=12tqMBugLF8aXzUXBn9f3J4ZBI3tRGmzB", h: '8a6e150e2d71dd601daf48d7967e273e940347a4826c2004b71ed1a9fa99c962' },
  { p: "assets/models/nature/Rock_2.fbx", u: "https://drive.google.com/uc?export=download&id=1jWTnluuSePLmiSw-EcwCtNeL9_EQsv1Z", h: '5a06ef3ec0b90098666407792fd2ea03879a10d3d0b0fe09b47f0df3a04025a1' },
  { p: "assets/models/nature/Rock_3.fbx", u: "https://drive.google.com/uc?export=download&id=1dQ8kOkuHLvtO7TNxUeyfdPdxje3gn_Aa", h: '4144136bd6c313ac7c48a08548504d7d30b7d628f35ce9dcd290ebe84e10e734' },
  { p: "assets/models/nature/Rock_4.fbx", u: "https://drive.google.com/uc?export=download&id=1-bW68SbgWF7kOr-vSDmnOX_gDjHQONBd", h: 'a914a59150ad1c12ff01ffc11de22b826fee9d52dabeb703fb43e7bde1f04e1d' },
  { p: "assets/models/nature/Rock_5.fbx", u: "https://drive.google.com/uc?export=download&id=1zDajY-XMdijIX1TOgzqZcpbw75-afvhl", h: 'a335cfa716e962010450026884f19c7474967682334635286ca315eef3490c94' },
  { p: "assets/models/nature/Rock_6.fbx", u: "https://drive.google.com/uc?export=download&id=1G2lBW4LmwdfCtETRQo0PsxQ2YUecnX9h", h: '36f79bdcae803b60e5968487f4a9b26f589490817ace655a1045b960d1af81f3' },
  { p: "assets/models/nature/Rock_7.fbx", u: "https://drive.google.com/uc?export=download&id=1itD5dCImcHUd1WLLpSVLIja4XW66ItFe", h: 'a7e68ae16e6e7af933ad81249a1a7eadf5940d3528eeea9963751a3b3efd8129' },
  { p: "assets/models/nature/Rock_Moss_1.fbx", u: "https://drive.google.com/uc?export=download&id=1kpAljRvanOKO1qeUNmkYujfpfgzlKdOL", h: '94ea25751e2ce17ca55ab0ddf3a70d5fda1fca4f308d883f9e51451162faf20e' },
  { p: "assets/models/nature/Rock_Moss_2.fbx", u: "https://drive.google.com/uc?export=download&id=1HfooLXEAWgcxMHudQeADhFa-7qvOJt8w", h: '9e6bb49e692da8c21c6cf5cdb77bcf6b9956edb55e1719a265524f7007fc717c' },
  { p: "assets/models/nature/Rock_Moss_3.fbx", u: "https://drive.google.com/uc?export=download&id=1BUp6o_xjlwxN_DYzvNkn59hmDCJzrc_-", h: '5f51b88bb9fe3c1a77e504521fca0fe03dc055d406aa2586bd543ef0413aad0e' },
  { p: "assets/models/nature/Bush_1.fbx", u: "https://drive.google.com/uc?export=download&id=1ZsG4jqj_Ewd5cABGO9UQnXEsQHZe4FGh", h: 'ef4fd15c36fd95a19aa769a15b4acde2a22bbfea4ada7144ece5fd82c2e05a0f' },
  { p: "assets/models/nature/Bush_2.fbx", u: "https://drive.google.com/uc?export=download&id=160vxT-BiKjbSEEaAW8HtHcWvtvgARD2K", h: '73a9aa512b2967ad333451ffb4b4e460f400a7a17a73a0b90fc1656404273388' },
  { p: "assets/models/nature/BushBerries_1.fbx", u: "https://drive.google.com/uc?export=download&id=1MRm8iusgwQ5jodg9MKXqd2lRQkMLuW4H", h: '1e70f836ae535b5e8bc7096abfa5f7fe2517ea8baa6d06964eff5296e39d7edc' },
  { p: "assets/models/nature/BushBerries_2.fbx", u: "https://drive.google.com/uc?export=download&id=1WJTuEAiVB6Y57VIBX_Yi9NHmyPG9pRZT", h: '02c360d6c2738e3ef42610aee3b00604ff2c5722cb6b773e23fa78f6d38cece4' },
  { p: "assets/models/nature/Grass.fbx", u: "https://drive.google.com/uc?export=download&id=1UHjltkOr9bilzYw2Si5Dg5Tkp-AgoYtZ", h: '849a2ca44c4765b47414bfd83eb8d276835db43c33d2755f7407006f5bb53c7e' },
  { p: "assets/models/nature/Grass_2.fbx", u: "https://drive.google.com/uc?export=download&id=1t1lioNMkJCwRp8UTw2OPkQl7o7de47nq", h: 'c7d84984661f8330d1c8e1f21f2cb0ede457586526b6bd38306d133d7c4f38c3' },
  { p: "assets/models/nature/Grass_Short.fbx", u: "https://drive.google.com/uc?export=download&id=1dAAEIiXDIHXpSNQB7Wq01m48Yp5XBtSA", h: '7244d7d8a30eb51e11e454083714f39d3b7d1d2512dd395b2acca787c064a7fa' },
  { p: "assets/models/nature/Flowers.fbx", u: "https://drive.google.com/uc?export=download&id=1ExBIUhWwwSE_xeRek0wk7Jw3Tsvq19aC", h: 'ffd9ad6299f0058855a97fcc819640ebed7131796c71a2eacb60b53d0d28d4c7' },
  { p: "assets/models/nature/Plant_1.fbx", u: "https://drive.google.com/uc?export=download&id=1ubOvNyJlaksdVV8dXRC22LQauHDKxEr-", h: '14fc5f5b4c29451e21da9626795125f59343952ea700217826a1061b46ea386f' },
  { p: "assets/models/nature/Plant_2.fbx", u: "https://drive.google.com/uc?export=download&id=1gv_Rp_CyFx-iYGGYNRm3WElrW9QKTsvH", h: 'dac0f960bfd59ecf9b9f449b57556e20dc113908d20f042772e79ed87336f6d7' },
  { p: "assets/models/nature/Plant_3.fbx", u: "https://drive.google.com/uc?export=download&id=1a6ygbU9wmRLvTHCn7O2gg8gp-2UKsS8i", h: 'dbf8f891b383b761953c9f497bb7e5dcdecf31de562944625af8181425064b31' },
  { p: "assets/models/nature/Plant_4.fbx", u: "https://drive.google.com/uc?export=download&id=1Xf1QnGVcCL-tJE3UAoSz8dVumiEselkE", h: '6495b56100a2e2cc2b87f5f809daf55fe9119ec3af8d613cfd3c7c659c15c7c3' },
  { p: "assets/models/nature/Plant_5.fbx", u: "https://drive.google.com/uc?export=download&id=1FQqcjqhiIJGiwkQKQFZAqhDH3tcjT37D", h: 'c1708097421a206f2309efee097038cd2896d9a22da13dd44e948fd2e32e013f' },
  { p: "assets/models/nature/TreeStump.fbx", u: "https://drive.google.com/uc?export=download&id=1QOtVG-SdMuSkM5OiLyfIjZWvzfvlBY5G", h: 'bb2f526c4259a915b49102ad374b9065d87153181c9dfb88a029068826fc88cb' },
  { p: "assets/models/nature/TreeStump_Moss.fbx", u: "https://drive.google.com/uc?export=download&id=1iIwsOEME8-PF8uRQVtPnhwxo9V9NlOjs", h: '53197f0637f5729af6f6cc4f20125b0575bdf8fa53ed21106430a80de0b35dec' },
  { p: "assets/models/nature/WoodLog.fbx", u: "https://drive.google.com/uc?export=download&id=1dcafRypWseMs7a9iBpolAt8XJ6MOIgV7", h: 'efc0eacf35939e10b6ca13cac145fda682ae65a624448fd43faebc84d98dbb02' },
  { p: "assets/models/nature/WoodLog_Moss.fbx", u: "https://drive.google.com/uc?export=download&id=1sLTeI4I858uFNWGX30UAPWbyO56mXGoZ", h: '5a18bfd817959e886d0e781efd8c2134801a70c45a86fa000df34b8c09b2a1cf' },
  { p: "assets/models/nature/Wheat.fbx", u: "https://drive.google.com/uc?export=download&id=1vaVkJlZptYNync8F-1trtAzNI_bCHIja", h: '590e4345e08fde9b0a5ba6cba205ecc6c6ba7279734325df9412a47621081f18' },
  { p: "assets/models/ruins/Arch_Round.fbx", u: "https://drive.google.com/uc?export=download&id=1DxPKAZdOaYm5ypzl4xFwbrvYpwtNE3Jt", h: '0fa77eafe953ac058e63aedca68ce1a82f02b6bbe009f53a0d3f7fc0120abcc8' },
  { p: "assets/models/ruins/Arch_Round_RoundColumn.fbx", u: "https://drive.google.com/uc?export=download&id=1hhwCwpva9p33LWKHjKFDw6tNNF3N3Wl1", h: '039670b60b4648a269884cd8378f0bbf0ec13b2f424887f8a90dee7f6fca20e2' },
  { p: "assets/models/ruins/Column_Round.fbx", u: "https://drive.google.com/uc?export=download&id=1jrKbSIFNCD1n3NmH3nflm9KhVGlt0Zfw", h: 'c9b3f643c5eca4b39e3490023555a053d0b490ae81a1838ed10940d1c3244d3e' },
  { p: "assets/models/ruins/Column_Round_Short.fbx", u: "https://drive.google.com/uc?export=download&id=1p5lWmpD-5k7Q0gi_G-puv4SNIgKOrjYt", h: 'f9c66da3c80b2576163afc2beee1e6dcbfbb3d65dc9307fb1a134163b9421ad0' },
  { p: "assets/models/ruins/Column_Square.fbx", u: "https://drive.google.com/uc?export=download&id=1_0DEnsiDGeJ26eRv3TByNH693PeYTNHG", h: 'df263445e20b73c2f5983036d55d0c6287984500be5700327b7208eed2e2dcbe' },
  { p: "assets/models/ruins/Column_BridgeSupport.fbx", u: "https://drive.google.com/uc?export=download&id=1NvcNB55KHspaR8jxSJ1m7gBF1ocftZGz", h: 'fd951b16e2e9d0d13ad0b3fea92a374b7a9b89ffee8737386d17a0979e122938' },
  { p: "assets/models/ruins/Wall.fbx", u: "https://drive.google.com/uc?export=download&id=1v_KTxbBLnAdJlB_dFfBYnWoKn3ZeuMqk", h: '6a37475da866a457f6b2872052c409576c6f7be5838a95cca3a51fbb75e19605' },
  { p: "assets/models/ruins/Wall_Half.fbx", u: "https://drive.google.com/uc?export=download&id=14E11FOcN63Q4wRblhdapMptxEKxK2zcI", h: '7f70fddb4008eea87da8aee398ecda3f7f6ad4a4248f0695a1c9b3d0a0708077' },
  { p: "assets/models/ruins/Wall_Broken.fbx", u: "https://drive.google.com/uc?export=download&id=1LckK0F3U4gNfjeJTjH6v_aVEMCHfs6oN", h: '6a4383be9c0b2101e1d471d8bb2a33e8b36ca95ca5b86e6b775b12b09ae76439' },
  { p: "assets/models/ruins/Wall_Hole.fbx", u: "https://drive.google.com/uc?export=download&id=16sF875-S7ezxiACMDrkSEt7WSyB0leUo", h: 'b5c5e7dbce3b07f9d46c94466820f5127008815e284b85298061384c6df86095' },
  { p: "assets/models/ruins/Wall_Double_Broken.fbx", u: "https://drive.google.com/uc?export=download&id=16aP1U7dIZwqoPkUzmpxF02ZOloiq6W08", h: '9d5351f316f73577593fa80e0ca495766308a136b79e98411fd71d086bb80693' },
  { p: "assets/models/ruins/Wall_ArchRound.fbx", u: "https://drive.google.com/uc?export=download&id=1RRULdgSFnXv3pL9ve9lMexnZ0c5aM1Bx", h: '3e9f6c6a498e9c585ad462e608bb498f0591fc6b80214de7b9281b28c3f857b5' },
  { p: "assets/models/ruins/Wall_ArchRound_Broken.fbx", u: "https://drive.google.com/uc?export=download&id=1fTXukvgRgvE412XIT__7fIXsX34NlK-C", h: '1ee949732ccc1599411c8cc6fa2ed7cacf983967695d90f78b3813fdb732d7e8' },
  { p: "assets/models/ruins/Wall_Overgrown.fbx", u: "https://drive.google.com/uc?export=download&id=1hHFIgvXRMmkP_gvuvCBSVENDGo6JqhrD", h: 'c0ea1ec251962e5cd04afee5d444cc9019faa1a7b1caed0033ce318dc3f04beb' },
  { p: "assets/models/ruins/Floor_Standard.fbx", u: "https://drive.google.com/uc?export=download&id=1Rtqq7rAFu3oEW-uSCCJaEhsWiGci1k5f", h: '5114ce65e16d4f404cc31294dbae8c1874e7cfefab6bec46ca790f7eba767f36' },
  { p: "assets/models/ruins/Floor_Standard_Half.fbx", u: "https://drive.google.com/uc?export=download&id=106romqHofM7Elsu5i3K-Jg404TOeWYLV", h: '2ebd309c037122fdacbbc8925b56a699ed328afa3d1734e30ecdb160bf410e42' },
  { p: "assets/models/ruins/Floor_SquareLarge.fbx", u: "https://drive.google.com/uc?export=download&id=12hd545qGy_fqFuiaRZlIb06FpCJzgchS", h: '8f4ae42df3f5990127b1c0b27886deebb411b747ee09c856e88cbcb86bd8cceb' },
  { p: "assets/models/ruins/Floor_Squares.fbx", u: "https://drive.google.com/uc?export=download&id=1DHA2uXOcjaZ7XSvLKQHSxl-qfi9WcfeX", h: '6aa3d8ebae6dccf5ede7b213eebbfe629db089c336b7dafca2b2b9c9f42d1d62' },
  { p: "assets/models/ruins/Floor_Diamond.fbx", u: "https://drive.google.com/uc?export=download&id=1biDsobZpf3aPMaJxmQgxX8lCqmRAuBzI", h: 'ff22d69fdd431c0e783afd6df7475a0932a0f6fee941884c8c04fe095a510f8a' },
  { p: "assets/models/ruins/Stairs.fbx", u: "https://drive.google.com/uc?export=download&id=1yAMcpPRxJZB_RrsW0q5AegqEWdklTgl7", h: 'b2e9bcbbfb966d43e5800b72a5ac45afd3c11901f5d3d65f9beb2ad127dc4552' },
  { p: "assets/models/ruins/Stairs_2.fbx", u: "https://drive.google.com/uc?export=download&id=1JqpjL03bJ9chTkd5PaigHp77AkxYVGVa", h: 'c1b646e1e8d4f37d9cea9fe289b1dda0bbdaaff2336b215233e6c4b7a5e7e5c1' },
  { p: "assets/models/ruins/BridgeSection.fbx", u: "https://drive.google.com/uc?export=download&id=1BWyfB8FICpw-fIiMaN2HYwa44GOx85Az", h: 'c26c4a11e868dfe3b342facd1a48aebe8b8fe3b49239fe649509753522deb960' },
  { p: "assets/models/ruins/Brick.fbx", u: "https://drive.google.com/uc?export=download&id=1eLKQYnixHLPI_7sk90lEzFrSvg6JDJA8", h: '645a4a1aea7a9da72609cdff285f701629ee4cb6429c64ef1d1a96853772e4b8' },
  { p: "assets/models/ruins/Bricks.fbx", u: "https://drive.google.com/uc?export=download&id=1_LEX1Uc_JrpU04FN8xp0c9msEkwhSehJ", h: '7f7d77c199b75e3c7cbb1534ed1c528215c08101b3d567f2a987c25feac273fa' },
  { p: "assets/models/ruins/Barrel.fbx", u: "https://drive.google.com/uc?export=download&id=1Yhj6CicstO3yc_VESbvWzRrEOli4bAby", h: '22f3f4fdb6296fff10dcb59f42eb28dd7ceff02982efc67a5df9e33c657d8df4' },
  { p: "assets/models/ruins/Crate.fbx", u: "https://drive.google.com/uc?export=download&id=1ud60D8c9UQli9exklq5W_szod4xrmfkE", h: '7418c22870df0c8181996712515abda96d5a0c50f2cb3ee938e69f47dec8a4b9' },
  { p: "assets/models/ruins/Cart.fbx", u: "https://drive.google.com/uc?export=download&id=1T-cduixeNMfgy1-9PQEVR-821oJEM-TL", h: '04d89e1d53bb01888aac3450103d45517ee4e63b1584ffc97d7375a177a74b16' },
  { p: "assets/models/ruins/Pot1.fbx", u: "https://drive.google.com/uc?export=download&id=1iubHtncbJZ08EBFPEWgrdKuwbazt43TP", h: '35fc7a2d293b9635f4ec6711e88ce7cb96fcf7f1a95c268454fb9cf30e999662' },
  { p: "assets/models/ruins/Pot2.fbx", u: "https://drive.google.com/uc?export=download&id=1149tEOYYtFAWxL98NJdIza9vqSSN_MKY", h: '23ef6465a25cac19fd3e2b84a0ec61a0d7c530dcb5a77f0aa17867dda7e534bc' },
  { p: "assets/models/ruins/Pot3.fbx", u: "https://drive.google.com/uc?export=download&id=1op14JwtKmSylooNKsf7VZBRBs3EQpfsp", h: '3e2bc8d77c498b49cf055b8aef6f729b6acf5be308ea4fce81aefeed816c8337' },
  { p: "assets/models/ruins/Pot1_Broken.fbx", u: "https://drive.google.com/uc?export=download&id=10P6C12Q-tJe_2lMQnBGe2rINV9rPaUVo", h: 'e318cc8c9ae246206d1c3528dd035d70da7ac9245a1f8aeadda8b14bfdc7b08b' },
  { p: "assets/models/ruins/Pot2_Broken.fbx", u: "https://drive.google.com/uc?export=download&id=1nWOBg70BwpsEQ7rQvY_kvYTaHOQiHXOa", h: 'b3de2b520aa45d4866a529eafd9ae7532f169c9d102bfb2f47a42c0abf8ec610' },
  { p: "assets/models/ruins/Torch.fbx", u: "https://drive.google.com/uc?export=download&id=1wGm4po8GJQO3EuvwwHv9H_lNjOxtUeGP", h: 'f2c06f7c23f88b528a4229354d17e5d04350daa1f8ed3c2fa0df69558826bcc2' },
  { p: "assets/models/ruins/Rail_Straight.fbx", u: "https://drive.google.com/uc?export=download&id=1K2jZXSc9sqSMR9UqqP-h0qoZEbHdjlZ7", h: 'b5f85de7fb062e76e6a5ddc82f42a7d219449addf5a005842ba866073ea47d0a' },
  { p: "assets/models/ruins/Rail_Corner.fbx", u: "https://drive.google.com/uc?export=download&id=19AJoeuWlDfflWQfXEiE0TWIJtPk-qeNp", h: 'fe16c399bafc4232fe260174f773890506230be8edc67b0651cb1a51422cc5f9' },
  { p: "assets/models/ruins/Support_Center.fbx", u: "https://drive.google.com/uc?export=download&id=18516QKBoRquY5DorCC85v2yiRS0uADub", h: '84fbc233888cd6e2680646e92526b69eabbbb3245fb84f99a8df5bda67f2b76c' },
  { p: "assets/models/ruins/Support_Left.fbx", u: "https://drive.google.com/uc?export=download&id=1F8HWHMztKXxsOvWm1JD0-oBumXCEA4Xg", h: '0435e636f0d24c48d6d3220257a5750f98546bed064cd9117f537280edad1019' },
  { p: "assets/models/ruins/Support_Right.fbx", u: "https://drive.google.com/uc?export=download&id=17d818QmNJTuWH5klq5y9dcOf2fKVsKv2", h: 'fc8115bcdf26b14e4d1435c33309588570b76022e6a352ba26307f2657c9c6ae' },
  { p: "assets/models/ruins/Support_Tall.fbx", u: "https://drive.google.com/uc?export=download&id=1vsfuRP7X605Sp9Fs2xtO6AtFXXccAH04", h: '46c01b4b258249997d6892517ffc4d3b298e3cbdaf0928f3f5dad4fed2c79a99' },
  { p: "assets/models/ruins/Doors_RoundArch.fbx", u: "https://drive.google.com/uc?export=download&id=1tLMEel-MqZwP9p3ERn3uBwY96w24CfcY", h: '4534d98ed94418f65b3ca1137437fc303bfd9fd604bdf3f83cf37241986c412d' },
  { p: "assets/models/ruins/Window_Open.fbx", u: "https://drive.google.com/uc?export=download&id=1Lzf0tYCDQUCCK14xYpAzu5SedirRoKu4", h: 'cedb47fe8a0c59384e3d6a0a0bf15e7b1ee7eab5dd8ee4ed1ce294b85f0cc7ff' },
  { p: "assets/models/ruins/Window_Bars.fbx", u: "https://drive.google.com/uc?export=download&id=1Jd20UYyyMNCJbW1Mr0msucapaJdGf3vN", h: '8f93ea6a05a5ec114dec9339e9c300497129a9d2e243ee89da1fb6b24b25d5de' },
  { p: "assets/models/ruins/Bark_Texture.jpg", u: "https://drive.google.com/uc?export=download&id=1mHXQU4hqlsibZH-txsgtXAJC4Wj4vBwK", h: 'd6fdb3cbf6df624bfe8e5d45fe7b5b1a05ec6d7b1fdb0fa4cc4774b4119bf017' },
  { p: "assets/models/ruins/Leaf_Texture.png", u: "https://drive.google.com/uc?export=download&id=1Aku5uUzp5USMjE-TkJjfAJZn6ovvOXAL", h: '34649aec779adde617568fc89e6ed24277d2bc5b254f592cdf26627f29fe63e0' },
  { p: "assets/models/animals/Horse.gltf", u: "https://drive.google.com/uc?export=download&id=1hbtY8kxnXiPdwYGVY7rWRgU0jl_-Q-LG", h: '3deb61550dff1d2786d04b6e8559d63ad3907d6ab606ba28ce0af074ed96341b' },
  { p: "assets/models/animals/Horse_White.gltf", u: "https://drive.google.com/uc?export=download&id=1sb2XaaPjEV9Z3a1bG8ReISiGlRXrSA7W", h: 'f137ee67bd565244f7441f35b5594a597588cda8b60ab109e2041cf13c58e1dd' },
  { p: "assets/models/animals/Donkey.gltf", u: "https://drive.google.com/uc?export=download&id=1Buic-_4vNtmwN0rtMHcdWw3TEaSPz4iW", h: '4cbb2eb7d057789c945b6445d99d0c73b76c0caf7ac9b37ce88a04ca718be2ff' },
  { p: "assets/models/animals/Bull.gltf", u: "https://drive.google.com/uc?export=download&id=1M9gyr2UikIDW_Ynp-OfgiK-JjI7ziPd3", h: '535da2992eb125d517725159a2eddeb520b72595bcb3021985fc43d2c84bff76' },
  { p: "assets/models/characters/Adventurer.gltf", u: "https://drive.google.com/uc?export=download&id=1fzSq1Rr037f7QkfXPWEAzmbLMNx-FpPA", h: '21f7a61afb6bd6cef6961490c367594e3c2fc01ec1f041662131172ce763063e' },
  { p: "assets/models/characters/Farmer.gltf", u: "https://drive.google.com/uc?export=download&id=1B9Dln-oR5Yk6sdsDR3yHCw86LobAN3Zd", h: '46d3e85fa8d848ee479ab8e4672c16724ee4ea51f3af5733705a153937f93555' },
  { p: "assets/models/characters/Worker.gltf", u: "https://drive.google.com/uc?export=download&id=14d8n7IDnnlnGt_uiATnNg3uvi_4dyd9V", h: 'e49f8ec0f8a7de72dd26b1c01e6413c9a87a9116eeee21f9364ccd36bc286335' },
  { p: "assets/models/characters/King.gltf", u: "https://drive.google.com/uc?export=download&id=1LmjkaT-i9zOKYiQ0zyYsf9zXGTJ9edXr", h: '659c7d84dcea8c6331698c3430484861944c83e629389425664b782d4aecd17c' },
];

const ALLOWED_HOSTS = new Set(['dl.polyhaven.org', 'drive.google.com', 'drive.usercontent.google.com']);
const ALLOWED_EXTS = new Set([
  '.glb', '.gltf', '.fbx', '.obj', '.blend',
  '.png', '.jpg', '.jpeg', '.webp', '.hdr', '.exr', '.wav', '.mp3', '.zip',
]);

/** Minimal magic-byte signatures. `null` => text-ish format, checked separately. */
const SIGNATURES = {
  '.jpg':  [[0xff, 0xd8, 0xff]],
  '.jpeg': [[0xff, 0xd8, 0xff]],
  '.png':  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  '.hdr':  [[0x23, 0x3f]],                                     // "#?RADIANCE"
  '.exr':  [[0x76, 0x2f, 0x31, 0x01]],
  '.glb':  [[0x67, 0x6c, 0x54, 0x46]],                         // "glTF"
  '.zip':  [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],
  '.blend':[[0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52]],       // "BLENDER" (uncompressed)
  '.fbx':  [[0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20,
             0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61]],  // "Kaydara FBX Bina"
  '.gltf': null,
  '.obj':  null,
};

/** Byte patterns that must never appear at the head of a downloaded media file. */
const FORBIDDEN_HEADS = [
  [0x4d, 0x5a],                          // MZ  -- DOS/PE executable
  [0x7f, 0x45, 0x4c, 0x46],              // ELF
  [0xfe, 0xed, 0xfa, 0xce],              // Mach-O 32 BE/LE
  [0xfe, 0xed, 0xfa, 0xcf],              // Mach-O 64
  [0xcf, 0xfa, 0xed, 0xfe],              // Mach-O 64 LE
  [0xce, 0xfa, 0xed, 0xfe],              // Mach-O 32 LE
  [0xca, 0xfe, 0xba, 0xbe],              // Mach-O universal / Java class
  [0x23, 0x21],                          // #!  -- script shebang
];

const startsWith = (buf, sig) => sig.every((b, i) => buf[i] === b);

function assertSafePayload(buf, relPath) {
  const ext = extname(relPath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`extension not allowed: ${ext}`);

  for (const bad of FORBIDDEN_HEADS) {
    if (startsWith(buf, bad)) throw new Error('payload looks like an executable/script - refusing');
  }

  const head = buf.subarray(0, 512).toString('latin1');
  if (/^\s*(<!doctype html|<html|<\?xml)/i.test(head)) {
    throw new Error('server returned an HTML/XML page instead of the asset');
  }

  const sigs = SIGNATURES[ext];
  if (sigs) {
    if (!sigs.some((s) => startsWith(buf, s))) {
      throw new Error(`magic bytes do not match ${ext}`);
    }
  } else if (ext === '.gltf') {
    if (!/^\s*\{/.test(head)) throw new Error('.gltf is not JSON');
  } else if (ext === '.obj') {
    if (!/(^|\n)\s*(v |vn |vt |f |o |g |#|mtllib|usemtl)/.test(head)) {
      throw new Error('.obj does not look like Wavefront OBJ');
    }
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function hashOnDisk(abs) {
  try { return sha256(await readFile(abs)); } catch { return null; }
}

async function download(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'Total-Claude asset fetcher (node)', accept: '*/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const finalHost = new URL(res.url).hostname;
      if (!ALLOWED_HOSTS.has(finalHost)) {
        throw new Error(`redirected off the allowlist: ${finalHost}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function handle(asset, { force, verifyOnly }) {
  const abs = join(PUBLIC, asset.p);
  const existing = await hashOnDisk(abs);

  if (existing && existing === asset.h && !force) return { state: 'ok', asset };
  if (verifyOnly) {
    if (!existing) return { state: 'missing', asset };
    return existing === asset.h ? { state: 'ok', asset } : { state: 'mismatch', asset, got: existing };
  }

  const host = new URL(asset.u).hostname;
  if (!ALLOWED_HOSTS.has(host)) return { state: 'error', asset, err: `host not allowed: ${host}` };

  const buf = await download(asset.u);
  try {
    assertSafePayload(buf, asset.p);
  } catch (err) {
    return { state: 'unsafe', asset, err: err.message };
  }

  const got = sha256(buf);
  if (asset.h && got !== asset.h) {
    return { state: 'mismatch', asset, got, err: 'SHA-256 mismatch - file discarded' };
  }

  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.part`;
  await writeFile(tmp, buf);
  await rename(tmp, abs);
  return { state: asset.h ? 'fetched' : 'fetched-unpinned', asset, got, bytes: buf.length };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx]); }
        catch (err) { out[idx] = { state: 'error', asset: items[idx], err: err.message }; }
      }
    }),
  );
  return out;
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const opts = { force: argv.has('--force'), verifyOnly: argv.has('--verify') };

  if (argv.has('--print-hashes')) {
    for (const a of ASSETS) {
      const h = await hashOnDisk(join(PUBLIC, a.p));
      console.log(`${h ?? 'MISSING'}  ${a.p}`);
    }
    return;
  }

  console.log(`${ASSETS.length} assets | mode: ${opts.verifyOnly ? 'verify' : opts.force ? 'force' : 'sync'}`);
  const results = await pool(ASSETS, 6, (a) => handle(a, opts));

  const tally = {};
  let bytes = 0;
  for (const r of results) {
    tally[r.state] = (tally[r.state] ?? 0) + 1;
    if (r.bytes) bytes += r.bytes;
    if (['unsafe', 'mismatch', 'error'].includes(r.state)) {
      console.error(`  !! ${r.state.toUpperCase()} ${r.asset.p}: ${r.err ?? ''}${r.got ? ` (got ${r.got.slice(0, 16)})` : ''}`);
      await rm(join(PUBLIC, `${r.asset.p}.part`), { force: true });
    }
    if (r.state === 'fetched-unpinned') console.log(`  ${r.got}  ${r.asset.p}`);
  }

  console.log(Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '));
  if (bytes) console.log(`downloaded ${(bytes / 1048576).toFixed(1)} MB`);

  const bad = results.filter((r) => ['unsafe', 'mismatch', 'error', 'missing'].includes(r.state));
  if (bad.length) { console.error(`FAILED: ${bad.length} asset(s)`); process.exitCode = 1; }
  else console.log('All assets present and integrity-verified.');
}

await main();
