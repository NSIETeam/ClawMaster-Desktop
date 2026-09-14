//! ClawMaster RPA native control plane.
//!
//! Recovered verbatim from the pre-DSH ClawMaster line, where it was described
//! as "a Rust control plane outside the runtime kernel". It uses installed
//! system browsers and the operating system's accessibility, mouse, keyboard
//! and screenshot APIs; it bundles no browser engine.
//!
//! The model never supplies a PID or a coordinate: it selects a window
//! reference and an element reference from an artifact produced by this crate,
//! and this crate resolves the element centre and issues the input event.

pub mod native_models;
pub mod native_pptx;
pub mod native_rpa;
pub mod native_state_store;
pub mod native_tools;
pub mod rpa_cli;
