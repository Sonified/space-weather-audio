// ═══════════════════════════════════════════════════════════════════════════════
// SHARED QUESTION RENDERER
// Pure HTML generators — no DOM manipulation, no event wiring.
// Used by both study-flow.js (live) and study-builder.html (preview).
// ═══════════════════════════════════════════════════════════════════════════════

export function buildDimensionStyle(step, defaultMaxWidth) {
    const rawW = String(step.modalWidth || defaultMaxWidth);
    const maxW = /^\d+$/.test(rawW) ? rawW + 'px' : rawW;
    let s = `box-sizing: border-box !important; width: 90% !important; max-width: ${maxW} !important;`;
    if (step.modalHeight) {
        const h = String(step.modalHeight);
        const hVal = /^\d+$/.test(h) ? h + 'px' : h;
        s += ` height: ${hVal} !important; max-height: ${hVal} !important;`;
    }
    return s;
}

export function buildTitleFontStyle(step) {
    let s = '';
    if (step.titleFontSize) s += `font-size: ${step.titleFontSize};`;
    if (step.titleFontColor) s += ` color: ${step.titleFontColor};`;
    if (step.titleFontBold === false) s += ' font-weight: normal;';
    else if (step.titleFontBold === true) s += ' font-weight: 700;';
    return s;
}

export function buildBodyFontStyle(step) {
    let s = '';
    if (step.bodyFontSize) s += `font-size: ${step.bodyFontSize};`;
    if (step.bodyFontColor) s += ` color: ${step.bodyFontColor};`;
    if (step.bodyFontBold) s += ' font-weight: 700;';
    return s;
}

export function buildHeaderUnderlineStyle(step) {
    if (step.titleUnderline === false) return 'border-bottom: none;';
    const size = step.titleUnderlineSize || '2px';
    const color = step.titleUnderlineColor || '#c86464';
    const r = parseInt(color.slice(1,3), 16);
    const g = parseInt(color.slice(3,5), 16);
    const b = parseInt(color.slice(5,7), 16);
    return `border-bottom: ${size} solid rgba(${r}, ${g}, ${b}, 0.3);`;
}

export function renderRadioOptions({ options, labelMode, inputName, previousAnswer, preview = false }) {
    const name = preview ? `preview_${inputName}` : `sq_${inputName}`;
    const disabled = '';
    return `
        <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;">
            ${options.map(opt => {
                let labelHtml = '';
                if (labelMode !== 'hidden' && opt.label) {
                    labelHtml = labelMode === 'bold'
                        ? `<strong>${opt.label}${opt.description ? ':' : ''}</strong> `
                        : `<span style="color:#333;">${opt.label}${opt.description ? ':' : ''}</span> `;
                }
                const checked = previousAnswer === opt.value ? ' checked' : '';
                return `
                <label class="radio-choice">
                    <input type="radio" name="${name}" value="${opt.value}"${checked}${disabled}>
                    <div>${labelHtml}<span style="color: #444; font-size: 0.92em;">${opt.description || ''}</span></div>
                </label>`;
            }).join('')}
        </div>
    `;
}

export function renderFreetextInput({ placeholder, previousAnswer, preview = false }) {
    const disabled = '';
    return `
        <textarea${disabled} placeholder="${placeholder || 'Type your response here...'}"
            style="width: 100%; flex: 1; min-height: 120px; padding: 14px; font-size: 15px; font-family: inherit; border: 1px solid #ddd; border-radius: 8px; resize: vertical; box-sizing: border-box; line-height: 1.5; color: #333;"
        >${previousAnswer || ''}</textarea>
    `;
}

export function renderLikertGrid({ scaleLabels, rows, inputName, previousAnswer, preview = false, boldRows = true, boldCols = true, colFontSize, colAlign, rowFontSize, rowAlign }) {
    const cols = scaleLabels || [];
    const items = rows || [];
    if (cols.length === 0 || items.length === 0) return '<div style="color:#999;font-style:italic;">No scale labels or rows defined.</div>';

    const namePrefix = preview ? `preview_${inputName}` : `sq_${inputName}`;
    const disabled = '';
    const prevObj = (previousAnswer && typeof previousAnswer === 'object') ? previousAnswer : {};
    let colStyle = boldCols ? 'font-weight:700;' : 'font-weight:400;';
    if (colFontSize) colStyle += `font-size:${colFontSize};`;
    if (colAlign === 'left') colStyle += 'justify-content:flex-start;text-align:left;';
    else if (colAlign === 'right') colStyle += 'justify-content:flex-end;text-align:right;';
    else if (colAlign === 'center') colStyle += 'justify-content:center;text-align:center;';
    let rowStyle = boldRows ? 'font-weight:700;' : 'font-weight:400;';
    if (rowFontSize) rowStyle += `font-size:${rowFontSize};`;
    if (rowAlign === 'right') rowStyle += 'justify-content:flex-end;text-align:right;';
    else if (rowAlign === 'center') rowStyle += 'justify-content:center;text-align:center;';
    else if (rowAlign === 'left') rowStyle += 'justify-content:flex-start;text-align:left;';

    // Header row
    let html = `<div class="likert-grid" style="grid-template-columns: minmax(140px, 1.5fr) repeat(${cols.length}, 1fr);">`;
    html += `<div class="likert-corner"></div>`;
    for (const lbl of cols) {
        html += `<div class="likert-col-header" style="${colStyle}">${lbl}</div>`;
    }

    // Body rows
    for (let r = 0; r < items.length; r++) {
        const evenClass = r % 2 === 1 ? ' likert-row-even' : '';
        html += `<div class="likert-row-label${evenClass}" style="${rowStyle}">${items[r]}</div>`;
        for (let c = 0; c < cols.length; c++) {
            const val = String(c + 1);
            const checked = prevObj[items[r]] === val ? ' checked' : '';
            html += `<div class="likert-cell${evenClass}"><input type="radio" name="${namePrefix}_row${r}" value="${val}"${checked}${disabled}></div>`;
        }
    }
    html += `</div>`;
    return html;
}

export function renderInfoModal({ step, bodyHtml, btnStyle, preview = false }) {
    const dimStyle = buildDimensionStyle(step, '560px');
    const ulStyle = buildHeaderUnderlineStyle(step);
    const titleFont = buildTitleFontStyle(step);
    const bodyFont = buildBodyFontStyle(step);
    const bodyPStyle = `${bodyFont}line-height:1.6;margin:0;`;

    // Apply per-paragraph styling + force links to open in new tab
    const styledBody = (bodyHtml || '')
        .replace(/<p>/g, `<p style="${bodyPStyle}">`)
        .replace(/<a /g, '<a target="_blank" rel="noopener" ');

    return `
        <div class="modal-content" style="${dimStyle} display: flex; flex-direction: column;">
            <div class="modal-header" style="${ulStyle}">
                <h3 class="modal-title" style="${titleFont}">${step.title || ''}</h3>
                ${step.closable ? '<button class="modal-close">&times;</button>' : ''}
            </div>
            <div class="modal-body" style="flex: 1;">
                <div style="${bodyFont}line-height: 1.6; text-align: left;">
                    ${styledBody}
                </div>
                ${step.hideButton ? '' : `<div style="text-align: center; margin-top: 16px;">
                    <div style="display: inline-flex; gap: 12px; align-items: center;">
                        <button type="button" class="modal-submit modal-dismiss" style="${btnStyle || ''} width: auto; min-width: 140px;">${step.dismissLabel || 'OK'}</button>
                    </div>
                </div>`}
            </div>
        </div>
    `;
}

export function renderRegistrationModal({ step, bodyHtml, preview = false }) {
    const dimStyle = buildDimensionStyle(step, '480px');
    const ulStyle = buildHeaderUnderlineStyle(step);
    const titleFont = buildTitleFontStyle(step);
    const bodyFont = buildBodyFontStyle(step);
    const bodyPStyle = `${bodyFont}line-height:1.6;margin:0;`;
    const title = step.regTitle || 'Welcome';
    const buttonLabel = step.regButtonLabel || 'Confirm';
    const placeholder = step.idPlaceholder || 'Enter your ID';

    const styledBody = (bodyHtml || '')
        .replace(/<p>/g, `<p style="${bodyPStyle}">`)
        .replace(/<a /g, '<a target="_blank" rel="noopener" ');

    return `
        <div class="modal-content" style="${dimStyle}">
            <div class="modal-header" style="${ulStyle}">
                <h3 class="modal-title" style="${titleFont}">🔬 ${title}</h3>
            </div>
            <div class="modal-body" style="${bodyFont}">
                ${styledBody}
                <div class="modal-form-group">
                    <input type="text" id="studyLoginInput" placeholder="${placeholder}" style="font-size: 18px;" autocomplete="off"${preview ? ' disabled' : ''}>
                </div>
                <button type="button" id="studyLoginSubmit" class="modal-submit" disabled>✓ ${buttonLabel}</button>
            </div>
        </div>
    `;
}

export function renderQuestionModal({ question, index, total, progressPct, previousAnswer, showBack, dims, preview = false }) {
    const qType = question.type || question.questionType || 'radio';
    let questionHtml = '';
    if (qType === 'likert') {
        questionHtml = renderLikertGrid({
            scaleLabels: question.scaleLabels || [],
            rows: question.rows || [],
            inputName: question.inputName || question.id || 'q',
            previousAnswer,
            preview,
            boldRows: question.likertBoldRows !== false,
            boldCols: question.likertBoldCols !== false,
            colFontSize: question.likertColFontSize,
            colAlign: question.likertColAlign,
            rowFontSize: question.likertRowFontSize,
            rowAlign: question.likertRowAlign,
        });
    } else if (qType === 'radio') {
        questionHtml = renderRadioOptions({
            options: question.options || [],
            labelMode: question.labelMode || 'bold',
            inputName: question.inputName || question.id || 'q',
            previousAnswer,
            preview
        });
    } else {
        questionHtml = renderFreetextInput({
            placeholder: question.placeholder,
            previousAnswer,
            preview
        });
    }

    const isLast = index === total - 1;
    const nextLabel = isLast ? '✓ Submit' : 'Next →';
    const stepDims = dims || {};
    const defaultWidth = qType === 'likert' ? '850px' : '750px';
    const dimStyle = buildDimensionStyle(stepDims, defaultWidth);
    const ulStyle = buildHeaderUnderlineStyle(stepDims);
    const titleFont = buildTitleFontStyle(stepDims);
    const isRequired = question.required !== false;
    let disabledNext = '';
    if (isRequired) {
        if (qType === 'likert') {
            const allFilled = previousAnswer && typeof previousAnswer === 'object'
                && Object.keys(previousAnswer).length === (question.rows || []).length
                && Object.values(previousAnswer).every(v => v);
            if (!allFilled) disabledNext = ' disabled';
        } else if (!previousAnswer) {
            disabledNext = ' disabled';
        }
    }

    return `
        <div class="modal-content emic-questionnaire-modal" style="${dimStyle} display: flex; flex-direction: column;">
            <div class="modal-header" style="${ulStyle}">
                <h3 class="modal-title" style="${titleFont}">${question.title || '📋 Questionnaire'}</h3>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 13px; color: #999; font-weight: 500;">${index + 1} / ${total}</span>
                    <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                        <div style="height: 100%; width: ${progressPct}%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
            <div class="modal-body" style="flex: 1; display: flex; flex-direction: column;">
                <div style="font-size: 18px; color: #222; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                    ${index + 1}. ${question.text || question.title || ''}
                    ${question.subtitle ? `<br><span style="font-size: 14px; color: #555; font-weight: normal;">${question.subtitle}</span>` : ''}
                </div>
                ${questionHtml}
                <div style="text-align: center; margin-top: 16px;">
                    <div style="display: inline-flex; gap: 12px; align-items: center;">
                        ${showBack ? '<button type="button" class="modal-back modal-submit" style="background: #e0e0e0; color: #555; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;">← Back</button>' : ''}
                        <button type="button" class="modal-next modal-submit" style="width: auto; min-width: 140px;"${disabledNext}>${nextLabel}</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}
