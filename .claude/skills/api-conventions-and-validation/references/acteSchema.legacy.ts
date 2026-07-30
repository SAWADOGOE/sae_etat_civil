import z from 'zod'

export const acteSchema = z.object({
    numero_acte: z.string().min(1,{message: "numero de l'acte invalide"}),
    type_acte: z.string({invalid_type_error: "renseignÃ© le type"}).min(1, {message: 'renseignÃ© le type'}),
    date_etablissement: z.string().nullable(),
    nom: z.string({invalid_type_error: "renseignez le nom de l'enfant"}).min(1, "Le nom de l\'enfant ne peut pas Ãªtre vide"),
    prenom: z.string({invalid_type_error: "renseignez le prenom de l'enfant"}).min(1, "Le prenom de l\'enfant ne peut pas Ãªtre vide"),
    date_naissance: z.string({invalid_type_error: "renseignez la date de naissance"}).min(4,'date de naissance invalide'),
    date_naissance_pere: z.string().nullable(),
    date_naissance_mere: z.string().nullable(),
    sexe: z.string().nullable(),
    article: z.enum(['le', 'vers', 'en']).default('le'),
}).superRefine((data, ctx) => {
    const value = (data.date_naissance ?? '').trim();

    if (!value) {
        return;
    }

    if (data.article === 'le') {
        if (!/^(\d{2})\/(\d{2})\/(\d{4})$/.test(value)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['date_naissance'],
                message: 'format jj/mm/aaaa requis',
            });
        }
        return;
    }

    if (!/^\d{4}$/.test(value)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['date_naissance'],
            message: 'format aaaa requis',
        });
    }
})
