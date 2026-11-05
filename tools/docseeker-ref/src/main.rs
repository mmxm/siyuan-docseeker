//! Binaire de reference : applique `search_core::process_search_results` (moteur DocSeeker reel)
//! a des lignes SQL synthetiques.
//!
//! Entree (stdin) : {"terms": ["mot", ...], "rows": [RawSqlSearchRow, ...]}
//! Sortie (stdout) : {"queryHash": "...", "results": [{id, title, relevanceScore, totalOccurrences, occurrences: [...]}]}
//! Les `matched_terms` (issus d'un HashSet, ordre non deterministe) sont tries.
use std::io::Read;

use search_core::{get_query_hash, process_search_results, RawSqlSearchRow};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Input {
    terms: Vec<String>,
    rows: Vec<RawSqlSearchRow>,
}

fn main() {
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .expect("lecture de stdin impossible");
    let input: Input = serde_json::from_str(&raw).expect("JSON d'entree invalide");
    let query_hash = get_query_hash(&input.terms);
    let results = process_search_results(&input.rows, &input.terms, &query_hash);

    let docs: Vec<_> = results
        .iter()
        .map(|d| {
            let occurrences: Vec<_> = d
                .occurrences_by_page
                .iter()
                .map(|o| {
                    let mut matched = o.matched_terms.clone();
                    matched.sort();
                    json!({
                        "page": o.page_number,
                        "occId": o.occ_id,
                        "distinctTerms": o.distinct_terms_count,
                        "matchedTerms": matched,
                        "text": o.text_snippet,
                        "rect": o.rect,
                        "highlightRects": o.highlight_rects,
                        "fontSize": o.font_size,
                        "bm25": o.bm25_score,
                    })
                })
                .collect();
            json!({
                "id": d.id,
                "title": d.title,
                "relevanceScore": d.relevance_score,
                "totalOccurrences": d.total_occurrences,
                "occurrences": occurrences,
            })
        })
        .collect();

    println!(
        "{}",
        serde_json::to_string(&json!({ "queryHash": query_hash, "results": docs })).unwrap()
    );
}
