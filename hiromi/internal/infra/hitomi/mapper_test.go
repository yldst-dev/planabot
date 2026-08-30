package hitomi

import (
	"encoding/json"
	"testing"

	"hiromi/internal/domain"
)

func TestMapGallery(t *testing.T) {
	raw := []byte(`var galleryinfo = {"id":1234567,"title":"Umi no Yeah!!","japanese_title":null,"type":"manga","language":"spanish","language_localname":"Español","language_url":"/index-spanish.html","galleryurl":"/manga/umi-1234567.html","date":"2018-06-03 12:23:00-05","datepublished":null,"blocked":0,"videofilename":null,"related":[1208126],"scene_indexes":[],"artists":[{"artist":"aoi hitori","url":"/artist/aoi%20hitori-all.html"}],"groups":null,"parodys":null,"characters":null,"tags":[{"male":"","female":1,"tag":"ahegao","url":"/tag/female%3Aahegao-all.html"}],"files":[{"name":"01.jpg","height":1841,"hasavif":1,"hash":"8d0f5c4f040555966b1d757828071b7a68b2106df1bd27a428740ed993eb8292","width":1280}],"languages":[]}`)
	var g rawGallery
	if err := json.Unmarshal(stripGalleryJS(raw), &g); err != nil {
		t.Fatal(err)
	}
	d := g.toDomain()
	if d.ID != 1234567 {
		t.Fatalf("id %d", d.ID)
	}
	if d.Type != domain.TypeManga {
		t.Fatalf("type %s", d.Type)
	}
	if d.Language == nil || d.Language.Name != "spanish" {
		t.Fatalf("lang %+v", d.Language)
	}
	if d.AddedAt.IsZero() {
		t.Fatal("date")
	}
	if len(d.Artists) != 1 || d.Artists[0].Name != "aoi hitori" {
		t.Fatalf("artists %+v", d.Artists)
	}
	if len(d.Tags) != 1 || d.Tags[0].Type != domain.TagFemale {
		t.Fatalf("tags %+v", d.Tags)
	}
	if len(d.Files) != 1 || !d.Files[0].HasAVIF || !d.Files[0].HasWebP {
		t.Fatalf("files %+v", d.Files)
	}
	if !d.Files[0].HasThumb {
		t.Fatal("thumb")
	}
}

func TestFlexIDAndFlag(t *testing.T) {
	var id flexID
	if err := json.Unmarshal([]byte(`"42"`), &id); err != nil || id != 42 {
		t.Fatalf("%d %v", id, err)
	}
	if err := json.Unmarshal([]byte(`7`), &id); err != nil || id != 7 {
		t.Fatalf("%d %v", id, err)
	}
	var f flag
	if err := json.Unmarshal([]byte(`"1"`), &f); err != nil || !f {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`""`), &f); err != nil || f {
		t.Fatal(err)
	}
}

func TestHashTermLength(t *testing.T) {
	h := hashTerm("serina")
	if len(h) != 4 {
		t.Fatalf("len %d", len(h))
	}
}
