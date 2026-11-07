use super::*;
use crate::dates::Dates;
use feedtorrent_bep::bep44::Bep44Signer;
fn key() -> MutableKey {
    MutableKey::new(Bep44Signer::from_seed(&[42; 32]).public_key(), vec![0, 255]).unwrap()
}
fn date(c: &BuiltCatalog) -> Dates {
    let files: Vec<_> = c
        .files
        .iter()
        .map(|f| (f.path.clone(), f.data.clone()))
        .collect();
    verify_payload(&c.metainfo, &files).unwrap();
    let raw = &c
        .files
        .iter()
        .find(|f| f.path == ["metadata", "dates.json"])
        .unwrap()
        .data;
    let d = Dates::parse(raw).unwrap();
    let outer = format!("13:creation datei{}e", d.updated_at);
    assert!(c
        .metainfo
        .windows(outer.len())
        .any(|b| b == outer.as_bytes()));
    d
}
fn page(id: u64) -> Page {
    Page {
        id,
        title: format!("page-{id}"),
        body: format!("body-{id}"),
        entries: vec![],
    }
}
#[test]
fn first_dates_match_and_only_changed_pages_advance() {
    let mut draft = Draft::new("root".into());
    draft.pages[0].body = "root body".into();
    draft.pages[0].entries = vec![Entry::Page { page: 2 }, Entry::Page { page: 3 }];
    draft.pages.extend([page(2), page(3)]);
    let first = draft.build(&key(), &BTreeMap::new(), 1000).unwrap();
    assert_eq!(first.catalogs.len(), 3);
    for c in &first.catalogs {
        assert_eq!(date(c), Dates::new(Some(1000), 1000).unwrap());
    }
    let same = draft
        .build_with_previous_root(&key(), &first.pages, Some(first.root), 2000)
        .unwrap();
    assert!(same.catalogs.is_empty());
    assert_eq!(same.root, first.root);
    for id in [1, 2, 3] {
        assert_eq!(same.pages[&id].metainfo, first.pages[&id].metainfo);
        assert_eq!(same.pages[&id].dates, first.pages[&id].dates);
    }
    draft.pages[1].body = "edited child".into();
    let changed = draft
        .build_with_previous_root(&key(), &first.pages, Some(first.root), 3000)
        .unwrap();
    assert_eq!(
        changed.catalogs.iter().map(|c| c.page).collect::<Vec<_>>(),
        vec![2, 1]
    );
    for c in &changed.catalogs {
        assert_eq!(date(c), Dates::new(Some(1000), 3000).unwrap());
    }
    assert_eq!(changed.pages[&3].metainfo, first.pages[&3].metainfo);
    assert_eq!(changed.pages[&3].dates, first.pages[&3].dates);
}
#[test]
fn legacy_origin_is_unknown_and_a_new_nested_page_has_its_own_start() {
    let mut draft = Draft::new("legacy".into());
    draft.pages[0].body = "old".into();
    draft.pages[0].entries.push(Entry::Page { page: 2 });
    draft.pages.push(page(2));
    let old = draft.preview(&key(), &BTreeMap::new()).unwrap();
    assert!(old.pages.values().all(|p| p.dates.is_none()));
    draft.pages[0].body = "updated".into();
    draft.pages[0].entries.push(Entry::Page { page: 3 });
    draft.pages.push(page(3));
    let changed = draft
        .build_with_previous_root(&key(), &old.pages, Some(old.root), 2000)
        .unwrap();
    assert_eq!(
        changed.pages[&1].dates,
        Some(Dates::new(None, 2000).unwrap())
    );
    assert_eq!(
        changed.pages[&3].dates,
        Some(Dates::new(Some(2000), 2000).unwrap())
    );
    assert_eq!(changed.pages[&2].metainfo, old.pages[&2].metainfo);
    assert!(changed.pages[&2].dates.is_none());
    let restored = draft
        .build_with_previous_root(&key(), &BTreeMap::new(), Some(old.root), 3000)
        .unwrap();
    assert_eq!(
        restored.pages[&1].dates,
        Some(Dates::new(None, 3000).unwrap())
    );
    assert_eq!(
        restored.pages[&2].dates,
        Some(Dates::new(Some(3000), 3000).unwrap())
    );
}
#[test]
fn attached_outer_metadata_and_virtual_previews_are_preserved() {
    let mut attached = FeedBuilder::new("attachment");
    attached
        .entries
        .push(BuildEntry::file(vec!["data".into()], 3));
    attached
        .outer
        .insert(Cow::Borrowed(b"creation date"), OuterValue::Integer(123));
    let original = attached
        .build(|_| Ok(Cursor::new(b"abc")))
        .unwrap()
        .metainfo;
    let mut draft = Draft::new("post".into());
    draft.pages[0].body = "published".into();
    draft.pages[0].entries.push(Entry::Torrent {
        name: "attachment.torrent".into(),
        data: original.clone(),
    });
    let first = draft.build(&key(), &BTreeMap::new(), 1000).unwrap();
    assert_eq!(first.catalogs[0].files[1].data, original);
    let preview = draft.preview(&key(), &first.pages).unwrap();
    assert!(preview.catalogs.is_empty());
    assert_eq!(preview.root, first.root);
    draft.pages[0].body = "draft edit".into();
    let preview = draft.preview(&key(), &first.pages).unwrap();
    assert!(preview
        .catalogs
        .iter()
        .all(|c| !c.files.iter().any(|f| f.path == ["metadata", "dates.json"])));
    let updated = draft.build(&key(), &first.pages, 2000).unwrap();
    assert_eq!(
        date(&updated.catalogs[0]),
        Dates::new(Some(1000), 2000).unwrap()
    );
    assert_eq!(updated.catalogs[0].files[1].data, original);
    assert!(draft.build(&key(), &first.pages, 999).is_err());
    draft.pages[0].body.clear();
    draft.pages[0].entries[0] = Entry::Torrent {
        name: "metadata".into(),
        data: original,
    };
    assert!(draft.build(&key(), &BTreeMap::new(), 2000).is_ok());
}
#[test]
fn moving_the_root_keeps_the_posts_original_date_and_history() {
    let mut draft = Draft::new("original root".into());
    draft.pages[0].body = "root body".into();
    let first = draft.build(&key(), &BTreeMap::new(), 1000).unwrap();
    draft.pages[0].entries.push(Entry::Page { page: 2 });
    draft.pages.push(page(2));
    let second = draft
        .build_with_previous_root(&key(), &first.pages, Some(first.root), 2000)
        .unwrap();
    assert_eq!(second.pages[&2].dates.unwrap().created_at, Some(2000));
    draft.root = 2;
    draft.pages[0].entries.clear();
    draft.pages[1].entries.push(Entry::Page { page: 1 });
    let third = draft
        .build_with_previous_root(&key(), &second.pages, Some(second.root), 3000)
        .unwrap();
    assert_eq!(
        third.pages[&2].dates,
        Some(Dates::new(Some(1000), 3000).unwrap())
    );
    assert_eq!(
        Feed::from_metainfo(&third.pages[&2].metainfo)
            .unwrap()
            .fields()
            .previous
            .as_ref()
            .unwrap()
            .infohash(),
        second.root
    );
}
