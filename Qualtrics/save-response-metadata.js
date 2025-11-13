/**
 * Save Qualtrics Response Metadata to JSON file
 * 
 * This script reads response metadata from localStorage (via browser console)
 * and saves it to a JSON file in the Qualtrics folder.
 * 
 * Usage:
 * 1. After submitting to Qualtrics, open browser console
 * 2. Run: node Qualtrics/save-response-metadata.js <responseId>
 *    OR copy the metadata from console and paste it into a file
 * 
 * Alternatively, you can manually copy the JSON from the console logs
 * after submission.
 */

const fs = require('fs');
const path = require('path');

// Get response ID from command line argument
const responseId = process.argv[2];

if (!responseId) {
    console.error('Usage: node save-response-metadata.js <qualtricsResponseId>');
    console.error('Example: node save-response-metadata.js R_abc123xyz');
    process.exit(1);
}

// This is a helper script - the actual metadata should be copied from browser console
// after submission, or we can create a better solution

console.log('This script requires the metadata to be passed or read from a file.');
console.log('For now, the metadata is logged to console after submission.');
console.log('You can copy it from there and save it manually.');

