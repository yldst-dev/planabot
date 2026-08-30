package domain

type Language struct {
	Name      string
	LocalName string
}

func (l Language) URLPath() string {
	if l.Name == "" {
		return ""
	}
	return "/index-" + l.Name + ".html"
}

func (l Language) Tag() Tag {
	return Tag{Type: TagLanguage, Name: l.Name}
}

type languageEntry struct {
	Name      string
	LocalName string
}

var orderedLanguages = []languageEntry{
	{"indonesian", "Bahasa Indonesia"},
	{"javanese", "Basa Jawa"},
	{"catalan", "Català"},
	{"cebuano", "Cebuano"},
	{"czech", "Čeština"},
	{"danish", "Dansk"},
	{"german", "Deutsch"},
	{"estonian", "Eesti"},
	{"english", "English"},
	{"spanish", "Español"},
	{"esperanto", "Esperanto"},
	{"french", "Français"},
	{"hindi", "Hindi"},
	{"icelandic", "Íslenska"},
	{"italian", "Italiano"},
	{"latin", "Latina"},
	{"hungarian", "Magyar"},
	{"dutch", "Nederlands"},
	{"norwegian", "Norsk"},
	{"polish", "Polski"},
	{"portuguese", "Português"},
	{"romanian", "Română"},
	{"albanian", "Shqip"},
	{"slovak", "Slovenčina"},
	{"serbian", "Srpski"},
	{"finnish", "Suomi"},
	{"swedish", "Svenska"},
	{"tagalog", "Tagalog"},
	{"vietnamese", "Tiếng Việt"},
	{"turkish", "Türkçe"},
	{"greek", "Ελληνικά"},
	{"bulgarian", "Български"},
	{"mongolian", "Монгол"},
	{"russian", "Русский"},
	{"ukrainian", "Українська"},
	{"hebrew", "עברית"},
	{"arabic", "العربية"},
	{"persian", "فارسی"},
	{"thai", "ไทย"},
	{"burmese", "မြန်မာဘာသာ"},
	{"korean", "한국어"},
	{"chinese", "中文"},
	{"japanese", "日本語"},
}

func AllLanguages() []Language {
	out := make([]Language, 0, len(orderedLanguages))
	for _, e := range orderedLanguages {
		out = append(out, Language{Name: e.Name, LocalName: e.LocalName})
	}
	return out
}

func LookupLanguage(name string) (Language, bool) {
	for _, e := range orderedLanguages {
		if e.Name == name {
			return Language{Name: e.Name, LocalName: e.LocalName}, true
		}
	}
	return Language{}, false
}

func KnownLanguage(name string) bool {
	_, ok := LookupLanguage(name)
	return ok
}

func LanguageLabel(name string) string {
	if name == "" {
		return ""
	}
	if lang, ok := LookupLanguage(name); ok {
		return lang.LocalName
	}
	return name
}

func LanguagesFromMask(mask uint64) []Language {
	out := make([]Language, 0, 8)
	for i, e := range orderedLanguages {
		if mask&(1<<uint(i)) != 0 {
			out = append(out, Language{Name: e.Name, LocalName: e.LocalName})
		}
	}
	return out
}
