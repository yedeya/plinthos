# Changelog

## [0.2.0](https://github.com/yedeya/plinthos/compare/v0.1.0...v0.2.0) (2026-11-04)


### Features

* **catalogue:** build the set index weekly from Rebrickable's downloads, and serve it to the admin ([#277](https://github.com/yedeya/plinthos/issues/277)) ([1141c70](https://github.com/yedeya/plinthos/commit/1141c707fe85e02b3c7e200b28e0b9e7d5c5ff04))
* **catalogue:** search the set index on the phone, offline included ([#275](https://github.com/yedeya/plinthos/issues/275)) ([#286](https://github.com/yedeya/plinthos/issues/286)) ([bfd8ece](https://github.com/yedeya/plinthos/commit/bfd8ecef7614995e1739e3252224a1d4a6a889d6))
* **items:** filter, count and sort the item list on /admin, kept in the URL ([#260](https://github.com/yedeya/plinthos/issues/260)) ([#269](https://github.com/yedeya/plinthos/issues/269)) ([6fb313f](https://github.com/yedeya/plinthos/commit/6fb313fefbc61be8c3c0433299078ad52e7c7f1f))


### Bug Fixes

* **export:** embed the printable catalogue's covers, so no burst of requests leaves them blank ([#284](https://github.com/yedeya/plinthos/issues/284)) ([2d195f0](https://github.com/yedeya/plinthos/commit/2d195f025791bebf67845a84d2ee706a93e16791))
* **offline:** the header's Back while a sync is with the server keeps the set queued ([#243](https://github.com/yedeya/plinthos/issues/243)) ([#283](https://github.com/yedeya/plinthos/issues/283)) ([c3bfecf](https://github.com/yedeya/plinthos/commit/c3bfecf530386d89393ef7fdd2a551ff802455ac))
* **publish:** restate the publish clauses the valuation work outgrew, and close gaps in their tests ([#289](https://github.com/yedeya/plinthos/issues/289)) ([6a7cd92](https://github.com/yedeya/plinthos/commit/6a7cd92ada33880acce15d55d546523abb0d94cd))
* **valuation:** no quote for an unlisted minifigure series, BrickLink secrets off the admin, doc restatements ([#288](https://github.com/yedeya/plinthos/issues/288)) ([4b4cbb3](https://github.com/yedeya/plinthos/commit/4b4cbb38978cf7ef0450413e9704ad931396012c))


### Documentation

* brief [#293](https://github.com/yedeya/plinthos/issues/293), the deployment's own domain ([#294](https://github.com/yedeya/plinthos/issues/294)) ([8e32847](https://github.com/yedeya/plinthos/commit/8e32847606b6ce07a501371b6a9167e403249cef))

## 0.1.0 (2026-11-04)


### Features

* add pino logging, its redaction and the failed-request path to the admin ([#41](https://github.com/yedeya/plinthos/issues/41)) ([66cd26d](https://github.com/yedeya/plinthos/commit/66cd26dff99316b6cc0bfed039e37eaf50a326b1))
* add the offline-sync endpoint, with idempotent mutations and conflicts ([#56](https://github.com/yedeya/plinthos/issues/56)) ([55dd628](https://github.com/yedeya/plinthos/commit/55dd628413a7f5d21f492b2b74791bc134ac6d38))
* **admin:** a loading screen while Aurora wakes, upload progress on Save, and a wider overview ([#203](https://github.com/yedeya/plinthos/issues/203)) ([#205](https://github.com/yedeya/plinthos/issues/205)) ([baab421](https://github.com/yedeya/plinthos/commit/baab421ed51fba637e486c9f95fb1a56ed8630d1))
* **admin:** build the item list and the one-screen entry form, with the admin's design system ([#128](https://github.com/yedeya/plinthos/issues/128)) ([#136](https://github.com/yedeya/plinthos/issues/136)) ([1a250bf](https://github.com/yedeya/plinthos/commit/1a250bf13b6434db2452b3f178462759654fbf6b))
* **admin:** one set field with a smarter, local-first search ([#200](https://github.com/yedeya/plinthos/issues/200)) ([e18491c](https://github.com/yedeya/plinthos/commit/e18491c03686742c4acac4dae7da6436257ff164))
* **admin:** the item list shows each set's stock image by default ([#149](https://github.com/yedeya/plinthos/issues/149)) ([d8041d5](https://github.com/yedeya/plinthos/commit/d8041d5a21132b584109aeb9845e04206a06df2a))
* **catalogue:** add a rate-limited Rebrickable client and its API key ([#129](https://github.com/yedeya/plinthos/issues/129)) ([60d427e](https://github.com/yedeya/plinthos/commit/60d427e9fed8fa20a48ecc2e1477b06c5d862017))
* **catalogue:** add the theme id and the top-level theme to lego_set ([#258](https://github.com/yedeya/plinthos/issues/258)) ([#264](https://github.com/yedeya/plinthos/issues/264)) ([89e0cfb](https://github.com/yedeya/plinthos/commit/89e0cfbfc6a4fcb9dd98d9171c0c090be56b2b40))
* create the SST app with its production stage, the Next.js shell and the deploy guide ([#32](https://github.com/yedeya/plinthos/issues/32)) ([4c78f33](https://github.com/yedeya/plinthos/commit/4c78f3396d4b5e42ef8d2414d886f7f60e084a79))
* **export:** CSV presets for a buyer and in full, and a one-page printable summary ([#236](https://github.com/yedeya/plinthos/issues/236)) ([#247](https://github.com/yedeya/plinthos/issues/247)) ([6c1a1df](https://github.com/yedeya/plinthos/commit/6c1a1df9c444acdf6a10173f33b329312db1f151))
* **export:** print the catalogue, not a one-page summary ([#255](https://github.com/yedeya/plinthos/issues/255)) ([#256](https://github.com/yedeya/plinthos/issues/256)) ([f6782cd](https://github.com/yedeya/plinthos/commit/f6782cde59120cc405114129adeae687e0cea0a2))
* **infra:** keep 35 days of database recovery, and deleted photos 30 days in a trash ([#148](https://github.com/yedeya/plinthos/issues/148)) ([945dc1f](https://github.com/yedeya/plinthos/commit/945dc1f2f256e413572d29d419caa76348e28549))
* **items:** add items, the cached set lookup and photos linked to items ([#127](https://github.com/yedeya/plinthos/issues/127)) ([#131](https://github.com/yedeya/plinthos/issues/131)) ([47b07ac](https://github.com/yedeya/plinthos/commit/47b07ac15ea30f2ba7fb77afbeedae07b35262e0))
* **items:** log minifigures, bulk lots and other LEGO items ([#202](https://github.com/yedeya/plinthos/issues/202)) ([#204](https://github.com/yedeya/plinthos/issues/204)) ([ef4a9ea](https://github.com/yedeya/plinthos/commit/ef4a9eaa21afb692b62e64a330742ed62ff78072))
* make the admin an installable web app with an offline queue ([#73](https://github.com/yedeya/plinthos/issues/73)) ([d285828](https://github.com/yedeya/plinthos/commit/d285828083801e2490d9a46fd7131aa0ecb3384b))
* **parts:** import the parts inventory from a BrickStore or BrickLink file, with its summary and overview photos ([#160](https://github.com/yedeya/plinthos/issues/160), [#161](https://github.com/yedeya/plinthos/issues/161)) ([#173](https://github.com/yedeya/plinthos/issues/173)) ([b436291](https://github.com/yedeya/plinthos/commit/b4362919e6b30ee5a6e3ef0a633a65b5122e236a))
* **publish:** publish the catalogue's content, its public photo copies and token rotation ([#162](https://github.com/yedeya/plinthos/issues/162)) ([#172](https://github.com/yedeya/plinthos/issues/172)) ([d8ea572](https://github.com/yedeya/plinthos/commit/d8ea57232633e41df610633880bb5ab2d509d240))
* **publish:** publish the parts summary and copies of the parts lot's overview photos ([#174](https://github.com/yedeya/plinthos/issues/174)) ([#184](https://github.com/yedeya/plinthos/issues/184)) ([93eaea5](https://github.com/yedeya/plinthos/commit/93eaea59138db3b514b5276d232e1a30537bea51))
* **publish:** show values and run selling mode in the catalogue, with split views and the parts download ([#211](https://github.com/yedeya/plinthos/issues/211)) ([#216](https://github.com/yedeya/plinthos/issues/216)) ([ca142e6](https://github.com/yedeya/plinthos/commit/ca142e62fd9b21533f318bdc085d4d324075a45a))
* queue photo uploads into a quarantine and re-encode them on the server ([#22](https://github.com/yedeya/plinthos/issues/22)) ([#92](https://github.com/yedeya/plinthos/issues/92)) ([4c0c50d](https://github.com/yedeya/plinthos/commit/4c0c50d61134cf82728fcaed0407620b4a918d64))
* refuse a login that did not come through the admin's CloudFront distribution ([#61](https://github.com/yedeya/plinthos/issues/61)) ([#76](https://github.com/yedeya/plinthos/issues/76)) ([c8c2314](https://github.com/yedeya/plinthos/commit/c8c2314ccea6158100a27c2f5ce1926c87434e5d))
* retry failed offline mutations automatically, with backoff ([#87](https://github.com/yedeya/plinthos/issues/87)) ([2bccf7f](https://github.com/yedeya/plinthos/commit/2bccf7f3a990f4836cbe9fa1f62e64b0c75ee929))
* serve the public snapshot from S3 through CloudFront, with a placeholder publish step ([#63](https://github.com/yedeya/plinthos/issues/63)) ([5ee9fb2](https://github.com/yedeya/plinthos/commit/5ee9fb2bdb9d422b3db28bbcbb2608b4dad971b9))
* sign the admin in from deployment configuration, with revocable sessions and rate limiting ([#57](https://github.com/yedeya/plinthos/issues/57)) ([68c2758](https://github.com/yedeya/plinthos/commit/68c2758fdba82d2e020d5915cf53b49d4f368c31))
* the catalogue's pages and the settings page ([#163](https://github.com/yedeya/plinthos/issues/163)) ([#171](https://github.com/yedeya/plinthos/issues/171)) ([455826b](https://github.com/yedeya/plinthos/commit/455826bec48df69349d414a7578fcf344e62aeaf))
* turn on deletion protection for the Aurora cluster ([#49](https://github.com/yedeya/plinthos/issues/49)) ([b344b66](https://github.com/yedeya/plinthos/commit/b344b664919ff7305e42bcd1c31208253e40cf04))
* **valuation:** a signed, rate-limited BrickLink price-guide client and its secrets ([#209](https://github.com/yedeya/plinthos/issues/209)) ([#212](https://github.com/yedeya/plinthos/issues/212)) ([7c04cdd](https://github.com/yedeya/plinthos/commit/7c04cddf8bbf4fe43e55ba30872e264c16e17598))
* **valuation:** run price refreshes as a background job, with quotes per parts lot ([#228](https://github.com/yedeya/plinthos/issues/228)) ([#230](https://github.com/yedeya/plinthos/issues/230)) ([12b1ed5](https://github.com/yedeya/plinthos/commit/12b1ed50fbc4a0bc68ab027811da9ecad087e724))
* **valuation:** store prices and values, with an on-demand refresh, overrides and adjustments ([#210](https://github.com/yedeya/plinthos/issues/210)) ([#214](https://github.com/yedeya/plinthos/issues/214)) ([3529e6f](https://github.com/yedeya/plinthos/commit/3529e6fe33f66e6061b5d1dc5e42c8e4c4ded65c))
* **valuation:** value the parts from BrickLink first, and show the refresh and each lot's source ([#229](https://github.com/yedeya/plinthos/issues/229)) ([#231](https://github.com/yedeya/plinthos/issues/231)) ([e6496b4](https://github.com/yedeya/plinthos/commit/e6496b402f0c439f0e9cbb1b09695970fef5fbb0))


### Bug Fixes

* **admin:** a typed set number's own set comes first in the search, and Delete moves away from Save ([#176](https://github.com/yedeya/plinthos/issues/176)) ([f0462cb](https://github.com/yedeya/plinthos/commit/f0462cb44337d98dc51266f3625b17ef44d0f534))
* **admin:** focus is drawn in blue, so the focused set search no longer looks invalid after Save & add next ([#196](https://github.com/yedeya/plinthos/issues/196)) ([e8fb253](https://github.com/yedeya/plinthos/commit/e8fb25378d1f5b8ab2c3ad53f48270901a244216))
* **admin:** Save shows the items once its sync has answered, and the list reloads after a sync ([#168](https://github.com/yedeya/plinthos/issues/168)) ([1d006c8](https://github.com/yedeya/plinthos/commit/1d006c8fe37a50e39184c0507764c3c4ff3aa8ca))
* **admin:** the entry form waits for photos being prepared, and ignores a second submit after a save ([#143](https://github.com/yedeya/plinthos/issues/143)) ([1fb60cb](https://github.com/yedeya/plinthos/commit/1fb60cb3e970e7ab2a5b7607f309ea53abe0980b))
* **admin:** the offline form ignores a second submit after Save & add next too ([#146](https://github.com/yedeya/plinthos/issues/146)) ([8a04874](https://github.com/yedeya/plinthos/commit/8a04874370d69ec750c8c43db060e819cdfd7bf9))
* **auth:** a credential change's sessions stay ended when the earlier value returns ([#72](https://github.com/yedeya/plinthos/issues/72)) ([db29f6d](https://github.com/yedeya/plinthos/commit/db29f6d23c0231919835c7da032e8b685970ac33))
* bound the smoke check by a five-minute deadline, as its wording says ([#71](https://github.com/yedeya/plinthos/issues/71)) ([11dc373](https://github.com/yedeya/plinthos/commit/11dc373ea237eee0bca411be27a2416722a861d3))
* **catalogue:** a queued Rebrickable call fails by its own deadline, not behind longer budgets ([#157](https://github.com/yedeya/plinthos/issues/157)) ([3b93149](https://github.com/yedeya/plinthos/commit/3b93149e07d7cf547ab57cfa0e9f59488a519b7f))
* **infra:** refuse every public IPv4 address, a component's included ([PLAT-5]) ([#53](https://github.com/yedeya/plinthos/issues/53)) ([4033d44](https://github.com/yedeya/plinthos/commit/4033d446e038994c909163684c5ed1089d9529ad))
* **items:** save a short typed set number without a pick ([#201](https://github.com/yedeya/plinthos/issues/201)) ([#239](https://github.com/yedeya/plinthos/issues/239)) ([87fed7e](https://github.com/yedeya/plinthos/commit/87fed7e0f6b97000a6ac711457c198a86b40a059))
* **items:** setItemPhotos holds its lock and writes atomically when called directly ([#139](https://github.com/yedeya/plinthos/issues/139)) ([#158](https://github.com/yedeya/plinthos/issues/158)) ([d71e2a6](https://github.com/yedeya/plinthos/commit/d71e2a6c991f02cd59a1e17a183dbd2a6769019b))
* lift @node-minify/core's glob to 10.5.0, clearing npm audit's three highs ([#51](https://github.com/yedeya/plinthos/issues/51)) ([989aebf](https://github.com/yedeya/plinthos/commit/989aebf3c7ea7ae86a7e769607fbd3fdddf3be6d))
* **logger:** redact credential keys in any letter case ([OPS-2]) ([#45](https://github.com/yedeya/plinthos/issues/45)) ([eecb5c0](https://github.com/yedeya/plinthos/commit/eecb5c0c4001a0d0545b5020478c8f0e65244c7a))
* **offline:** Save that leaves before its sync answers keeps the set queued ([#169](https://github.com/yedeya/plinthos/issues/169)) ([#240](https://github.com/yedeya/plinthos/issues/240)) ([7b7a8e7](https://github.com/yedeya/plinthos/commit/7b7a8e74de784917f6dc54340626b89a2d43210c))
* **offline:** sign-out no longer takes a queue that failed to open for an empty one ([SYNC-9]) ([#96](https://github.com/yedeya/plinthos/issues/96)) ([a4b6900](https://github.com/yedeya/plinthos/commit/a4b690027d71727991e800aee26227e687df3c3e))
* **parts:** skip a lot with no item number and report it, rather than refusing the file ([#206](https://github.com/yedeya/plinthos/issues/206)) ([aa950f1](https://github.com/yedeya/plinthos/commit/aa950f148db708fee66ba0e537fdc0072f2af040))
* **publish:** a delete of a published photo or set republishes the catalogue ([#187](https://github.com/yedeya/plinthos/issues/187)) ([#191](https://github.com/yedeya/plinthos/issues/191)) ([c271aa0](https://github.com/yedeya/plinthos/commit/c271aa05ba02600682bfeb10cf3c63fb9d9cb676))
* publishes take turns, so overlapping ones never roll back or mix a snapshot ([#68](https://github.com/yedeya/plinthos/issues/68)) ([#82](https://github.com/yedeya/plinthos/issues/82)) ([99518b4](https://github.com/yedeya/plinthos/commit/99518b4d9d66edb14c4f6b70c168014b2ed66960))
* **publish:** show the parts lot's overview photos without a 0-parts count before any import ([#185](https://github.com/yedeya/plinthos/issues/185)) ([#238](https://github.com/yedeya/plinthos/issues/238)) ([ed5e148](https://github.com/yedeya/plinthos/commit/ed5e14886de3df4bfea196cb3259ac0c37e72bad))
* refuse the public IPv4 paths the [PLAT-5] guards missed, and name the ones left out ([#77](https://github.com/yedeya/plinthos/issues/77)) ([fe08565](https://github.com/yedeya/plinthos/commit/fe08565b58a50fdcafa6008dbfaf4b238e798abc))
* send number-mode numerics with the Data API's DECIMAL hint, and keep the skipped-lots helpers out of a client module ([#223](https://github.com/yedeya/plinthos/issues/223)) ([#224](https://github.com/yedeya/plinthos/issues/224)) ([d501f36](https://github.com/yedeya/plinthos/commit/d501f36e4ccec480a013fb51951f27c1e5a7416c))
* **settings:** asking-price refusal writes the maximum without separators ([#219](https://github.com/yedeya/plinthos/issues/219)) ([#237](https://github.com/yedeya/plinthos/issues/237)) ([36413b3](https://github.com/yedeya/plinthos/commit/36413b3fb80d6f7d3cd011006b635c7e17e00fb3))
* stop one address from using up the login's total limit, and read both limits from configuration ([#66](https://github.com/yedeya/plinthos/issues/66)) ([c4fe155](https://github.com/yedeya/plinthos/commit/c4fe15541dc7c37767971129572db649b9a42383))
* **sync:** cap the photos one sync batch carries and set the server's timeout ([#104](https://github.com/yedeya/plinthos/issues/104)) ([e1e5d2a](https://github.com/yedeya/plinthos/commit/e1e5d2a41b0e6ab8178e6e973180931d77a0c432))
* **sync:** keep a batch's set lookups and photos inside the server function's timeout ([#165](https://github.com/yedeya/plinthos/issues/165)) ([924ebd2](https://github.com/yedeya/plinthos/commit/924ebd2b8969c7c53596f01a0ed72d0833f491d7))
* **test:** fail the run on any skipped test, and widen the lint skip ban ([#31](https://github.com/yedeya/plinthos/issues/31)) ([6330933](https://github.com/yedeya/plinthos/commit/63309335a215bcca3352adf1c5af7b181e69f75b))
* **tooling:** type-check eslint.config.js in the typecheck gate ([#48](https://github.com/yedeya/plinthos/issues/48)) ([f3ba199](https://github.com/yedeya/plinthos/commit/f3ba19900747aba45a7ea3f0da1680187df05631))
* **valuation:** ask BrickLink for a collectible minifigure by its own number ([#241](https://github.com/yedeya/plinthos/issues/241)) ([#242](https://github.com/yedeya/plinthos/issues/242)) ([dfcdbd4](https://github.com/yedeya/plinthos/commit/dfcdbd4c649acdaa8f0d46f3913ddc8642618309))
* **valuation:** map every collectible minifigure series by its box number ([#248](https://github.com/yedeya/plinthos/issues/248)) ([#249](https://github.com/yedeya/plinthos/issues/249)) ([7742fcb](https://github.com/yedeya/plinthos/commit/7742fcb8f4b6448489ad4fd814066f59fff30e08))


### Build and Dependencies

* set up the TypeScript workspace, the CI gates and the project-setup hook ([#26](https://github.com/yedeya/plinthos/issues/26)) ([aa59dd5](https://github.com/yedeya/plinthos/commit/aa59dd510a2a8325b3f2253b332411521aea23e7))


### Documentation

* add a one-page overview of the architecture and its monthly cost ([#97](https://github.com/yedeya/plinthos/issues/97)) ([f0cc252](https://github.com/yedeya/plinthos/commit/f0cc2521805723a4884da726b4dcff5d3a49d95d))
* add the product hand-over and the agent instructions ([3911ab0](https://github.com/yedeya/plinthos/commit/3911ab0ed1706554f449d2a6ff9189f78882b39e))
* **admin:** item-list's header says a row shows the stock image by default ([#156](https://github.com/yedeya/plinthos/issues/156)) ([d86fcc9](https://github.com/yedeya/plinthos/commit/d86fcc988e2c5ff50d8a9df4864a2906c093a0bc))
* brief [#207](https://github.com/yedeya/plinthos/issues/207), valuation and selling mode ([#208](https://github.com/yedeya/plinthos/issues/208)) ([b9178c6](https://github.com/yedeya/plinthos/commit/b9178c6667117e8f5cedf04e3a5192a41d075201))
* brief [#226](https://github.com/yedeya/plinthos/issues/226), parts prices from BrickLink in a background refresh ([#227](https://github.com/yedeya/plinthos/issues/227)) ([5071c6c](https://github.com/yedeya/plinthos/commit/5071c6c42f2ef37de607c0d29a228e822295fab8))
* brief [#233](https://github.com/yedeya/plinthos/issues/233), export and the printable summary ([#235](https://github.com/yedeya/plinthos/issues/235)) ([c485af2](https://github.com/yedeya/plinthos/commit/c485af28d8d9c1e1bd8c2d98c2770a3439a9a61c))
* brief [#251](https://github.com/yedeya/plinthos/issues/251), filters on the admin item list ([#253](https://github.com/yedeya/plinthos/issues/253)) ([120630d](https://github.com/yedeya/plinthos/commit/120630d3a8702fea2dd9831a1625ac290c4a3955))
* brief [#252](https://github.com/yedeya/plinthos/issues/252), a set search index on the phone ([#254](https://github.com/yedeya/plinthos/issues/254)) ([e5adb03](https://github.com/yedeya/plinthos/commit/e5adb03aada69c393edd6f9081e4653ef745e70a))
* brief the walking skeleton ([#6](https://github.com/yedeya/plinthos/issues/6)) ([#7](https://github.com/yedeya/plinthos/issues/7)) ([f2b49a6](https://github.com/yedeya/plinthos/commit/f2b49a643c8674a3620f08357d93f77d27517016))
* briefs [#153](https://github.com/yedeya/plinthos/issues/153) (parts import) and [#154](https://github.com/yedeya/plinthos/issues/154) (public catalogue) ([#159](https://github.com/yedeya/plinthos/issues/159)) ([636f4ae](https://github.com/yedeya/plinthos/commit/636f4ae1e5444879c6a0be8569d74db91d9b0780))
* **deploy:** a failed offline change is retried by itself before it is held ([#98](https://github.com/yedeya/plinthos/issues/98)) ([#119](https://github.com/yedeya/plinthos/issues/119)) ([9d22104](https://github.com/yedeya/plinthos/commit/9d22104360efd9805d55d26a5e1dfc232567042a))
* **deploy:** cover IAM Identity Center (SSO) profiles in step 1 ([#113](https://github.com/yedeya/plinthos/issues/113)) ([18aaef0](https://github.com/yedeya/plinthos/commit/18aaef0063950094a95c56d072b7b1e97df890bf))
* **deploy:** describe /admin as the publish and photo page it is ([#101](https://github.com/yedeya/plinthos/issues/101)) ([#118](https://github.com/yedeya/plinthos/issues/118)) ([c46d33f](https://github.com/yedeya/plinthos/commit/c46d33f255ba3f85c3ab2ee1fd50f9d23d3471f9))
* **deploy:** give a names-only secrets check and warn that sst secret list prints values ([#112](https://github.com/yedeya/plinthos/issues/112)) ([16f57c5](https://github.com/yedeya/plinthos/commit/16f57c51f25e7bcbbcf1e1a1684a8c656b726c46))
* **deploy:** name BrickLink's IP mask, and say a changed secret needs a deploy ([#220](https://github.com/yedeya/plinthos/issues/220)) ([#221](https://github.com/yedeya/plinthos/issues/221)) ([4eedd42](https://github.com/yedeya/plinthos/commit/4eedd42cc4c42d0e8ac22ee90e8c0ea2860bec19))
* **deploy:** say to use .nvmrc's Node, and which npm ci warnings are harmless ([#114](https://github.com/yedeya/plinthos/issues/114)) ([a8cb84e](https://github.com/yedeya/plinthos/commit/a8cb84e08f54b4bdf68e47f027f34ed568042ff7))
* **deploy:** say what signing in again before a deploy really gives ([#115](https://github.com/yedeya/plinthos/issues/115)) ([#120](https://github.com/yedeya/plinthos/issues/120)) ([cb176eb](https://github.com/yedeya/plinthos/commit/cb176eba99d33a32d6b275b3d50e92d9c6bc10ea))
* **deploy:** switch to the tag's Node.js version before npm ci after a checkout ([#117](https://github.com/yedeya/plinthos/issues/117)) ([a97d9d6](https://github.com/yedeya/plinthos/commit/a97d9d6bcb26bf74cda0ce9e1e8beebd5756d4c4))
* **deploy:** the Rebrickable rate limit is kept per server instance ([#152](https://github.com/yedeya/plinthos/issues/152)) ([e224aa6](https://github.com/yedeya/plinthos/commit/e224aa61a4a3ad894a35b5b89ba59d3bebf2e1c6))
* describe Plinthos in the README ([ffcdfa9](https://github.com/yedeya/plinthos/commit/ffcdfa9ce645fa176e959b10e8e521ace94d3454))
* end Kanon's bootstrap ([#2](https://github.com/yedeya/plinthos/issues/2)) ([62abd3b](https://github.com/yedeya/plinthos/commit/62abd3b5c45ec0803f09480304aba79e5a82f37a))
* **infra:** say the admin's viewer-request code is plain text in SST's state ([#84](https://github.com/yedeya/plinthos/issues/84)) ([#91](https://github.com/yedeya/plinthos/issues/91)) ([a410845](https://github.com/yedeya/plinthos/commit/a410845e1f24be98d2de84bed0dd420055c2f472))
* name queue.test.ts in the [SYNC-9] row, and fix deploy.md §8's lost-phone text ([#90](https://github.com/yedeya/plinthos/issues/90)) ([925b61c](https://github.com/yedeya/plinthos/commit/925b61c9fc6067a0f01d570cc89f9aac6f130dea))
* **observability:** mark the secrets and the alert subscription created, with delivery seen ([#23](https://github.com/yedeya/plinthos/issues/23)) ([#108](https://github.com/yedeya/plinthos/issues/108)) ([b3f9416](https://github.com/yedeya/plinthos/commit/b3f9416d33178320e9b2eef3a127d0d4a18ec8ef))
* **photos:** say a deleted photo's stored sizes move to the trash, not that they are deleted ([#155](https://github.com/yedeya/plinthos/issues/155)) ([0d4d65e](https://github.com/yedeya/plinthos/commit/0d4d65e6e872e6f89c7b11ad55c6f188d9593746))
* record the answers to HANDOVER's open questions ([#8](https://github.com/yedeya/plinthos/issues/8)) ([f4ce3f3](https://github.com/yedeya/plinthos/commit/f4ce3f3f2628b172c0c201cbc6ecf99706d5e8ee))
* record the expand-first rule for schema changes ([#78](https://github.com/yedeya/plinthos/issues/78)) ([#102](https://github.com/yedeya/plinthos/issues/102)) ([9eeb738](https://github.com/yedeya/plinthos/commit/9eeb738b460eeedf05473d5788644ae5f2a3f665))
* reframe Plinthos as a self-hosted catalogue for any LEGO collection ([#3](https://github.com/yedeya/plinthos/issues/3)) ([d1fdc39](https://github.com/yedeya/plinthos/commit/d1fdc396db0347647cf8e4ba8235923d5e598460))
* say what installing before the deploy role protects, and what doesn't ([#69](https://github.com/yedeya/plinthos/issues/69)) ([9f10ff9](https://github.com/yedeya/plinthos/commit/9f10ff9d58235bf528fbeb70bf10a29f1c1f8b3e))
* **specs:** [CAT-3] keys lego_set by a UUID, with the set number unique ([#125](https://github.com/yedeya/plinthos/issues/125)) ([2cf4dde](https://github.com/yedeya/plinthos/commit/2cf4dde2f112547fbfbde666833c6cbe74404e0f))
* the first security review ([#164](https://github.com/yedeya/plinthos/issues/164)) ([#189](https://github.com/yedeya/plinthos/issues/189)) ([3a407e9](https://github.com/yedeya/plinthos/commit/3a407e9e8cda84a3137a743a2ea33ea8374ddf79))


### Tests

* [AUTH-6] render's made-up query answers a presence check made with in or as an own property; doc names what it can't ([#81](https://github.com/yedeya/plinthos/issues/81)) ([#93](https://github.com/yedeya/plinthos/issues/93)) ([1294f05](https://github.com/yedeya/plinthos/commit/1294f05aba9740551531f895cefdd74ce975a49e))
* check every range GHSA-5j98-mcp5-4vw2 affects, 11.0.x as well as 10.x ([#70](https://github.com/yedeya/plinthos/issues/70)) ([83965d5](https://github.com/yedeya/plinthos/commit/83965d566b5f8e4fb8b7867fb511542d8f3f1b8f))
* cover the default resume-wait log through the one pino logger ([PLAT-10]) ([#50](https://github.com/yedeya/plinthos/issues/50)) ([72a5255](https://github.com/yedeya/plinthos/commit/72a52556cc142d11026eb3d948bb5c793d1fb87e))
* **db:** a set stored before 0014 reads null theme fields ([#258](https://github.com/yedeya/plinthos/issues/258)) ([#265](https://github.com/yedeya/plinthos/issues/265)) ([fc94999](https://github.com/yedeya/plinthos/commit/fc94999812919434b0f6d7d3e30ab05d8c36608a))
* hold inline Server Actions, admin layouts and metadata files to the admin check ([#59](https://github.com/yedeya/plinthos/issues/59)) ([#64](https://github.com/yedeya/plinthos/issues/64)) ([b6b5510](https://github.com/yedeya/plinthos/commit/b6b551080192279cc87c9ab3eb060844669e160b))
* **publish:** give the [PUB-4] canary matrix its own timeout, and empty tables without truncate ([#140](https://github.com/yedeya/plinthos/issues/140)) ([#141](https://github.com/yedeya/plinthos/issues/141)) ([0b70e5a](https://github.com/yedeya/plinthos/commit/0b70e5ae44a6ac4a2d4fb0f5eed202bb42a76734))
* render public pages and layouts as whole trees, so a component's database read counts ([#75](https://github.com/yedeya/plinthos/issues/75)) ([6697b68](https://github.com/yedeya/plinthos/commit/6697b68aaff7a60648b4f10b54a4b82fae6f3bc6))


### CI

* add the release and deploy lanes, production only ([#18](https://github.com/yedeya/plinthos/issues/18)) ([7b03246](https://github.com/yedeya/plinthos/commit/7b0324692dfed9d7d12a05cca07d14bb27a05d0f))
* install Kanon ([#1](https://github.com/yedeya/plinthos/issues/1)) ([d81b1b7](https://github.com/yedeya/plinthos/commit/d81b1b7ea86f8366e1040cf3c1a9df817969ec94))
* record the PHOTO invariants in the locked floor and run spec coverage in CI ([#103](https://github.com/yedeya/plinthos/issues/103)) ([f0dde10](https://github.com/yedeya/plinthos/commit/f0dde10b416747d41e7618eabcd07adef16a8a47))
* reword the gate comment, spec-coverage uses no project-setup hook ([#107](https://github.com/yedeya/plinthos/issues/107)) ([#121](https://github.com/yedeya/plinthos/issues/121)) ([ff6b1b8](https://github.com/yedeya/plinthos/commit/ff6b1b852c9746452f39aa969dd2fd89d8aeae8a))
