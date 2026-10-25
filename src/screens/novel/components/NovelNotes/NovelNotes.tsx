import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { IconButton, TextInput } from 'react-native-paper';
import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons';

import { Dialog } from '@components/Dialog';
import ConfirmationDialog from '@components/ConfirmationDialog/ConfirmationDialog';
import { getString } from '@i18n/translations';
import { getNovelById, updateNovelNotes } from '@database/queries/NovelQueries';
import { NovelInfo } from '@database/types';
import { ThemeColors } from '@theme/types';
import { showToast } from '@utils/showToast';
import { useNovelAction } from '../../NovelContext';

interface NovelNotesProps {
  novel: NovelInfo;
  theme: ThemeColors;
}

const NovelNotes: React.FC<NovelNotesProps> = ({ novel, theme }) => {
  const setNovel = useNovelAction('setNovel');
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const note = novel.notes?.trim() || '';

  const save = async (value: string | null) => {
    if (saving) return false;
    setSaving(true);
    try {
      const next = value?.trim() || null;
      await updateNovelNotes(novel.id, next);
      // Merge into the freshest novel, not the pre-await prop copy.
      const fresh = getNovelById(novel.id);
      setNovel({ ...(fresh ?? novel), notes: next });
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openEditor = () => {
    setDraft(note);
    setEditing(true);
  };

  return (
    <View style={styles.container}>
      {note ? (
        <>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.onSurface }]}>
              {getString('novelScreen.notes.title')}
            </Text>
            <IconButton
              icon="pencil-outline"
              size={20}
              iconColor={theme.onSurfaceVariant}
              accessibilityLabel={getString('novelScreen.notes.edit')}
              onPress={openEditor}
            />
            <IconButton
              icon="delete-outline"
              size={20}
              iconColor={theme.onSurfaceVariant}
              accessibilityLabel={getString('novelScreen.notes.delete')}
              onPress={() => setConfirmingDelete(true)}
            />
          </View>
          <Pressable onPress={() => setExpanded(e => !e)}>
            <Text
              selectable
              numberOfLines={expanded ? undefined : 4}
              style={[styles.text, { color: theme.onSurfaceVariant }]}
            >
              {note}
            </Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          style={styles.addRow}
          onPress={openEditor}
          accessibilityRole="button"
        >
          <MaterialCommunityIcons
            name="note-plus-outline"
            size={20}
            color={theme.onSurfaceVariant}
          />
          <Text style={[styles.addText, { color: theme.onSurfaceVariant }]}>
            {getString('novelScreen.notes.add')}
          </Text>
        </Pressable>
      )}

      <Dialog.Root visible={editing} onDismiss={() => setEditing(false)}>
        <Dialog.Title>
          {getString(note ? 'novelScreen.notes.edit' : 'novelScreen.notes.add')}
        </Dialog.Title>
        <Dialog.Content>
          <TextInput
            autoFocus
            multiline
            numberOfLines={6}
            style={styles.input}
            defaultValue={draft}
            placeholder={getString('novelScreen.notes.placeholder')}
            onChangeText={setDraft}
            mode="outlined"
            theme={{ colors: { ...theme } }}
          />
        </Dialog.Content>
        <Dialog.Actions>
          <Dialog.Action onPress={() => setEditing(false)}>
            {getString('common.cancel')}
          </Dialog.Action>
          <Dialog.Action
            disabled={saving}
            onPress={async () => {
              // empty text deletes the note; stay open on failure
              if (await save(draft)) setEditing(false);
            }}
          >
            {getString('common.save')}
          </Dialog.Action>
        </Dialog.Actions>
      </Dialog.Root>

      <ConfirmationDialog
        visible={confirmingDelete}
        title={getString('novelScreen.notes.deleteConfirm')}
        confirmLabel={getString('common.delete')}
        onConfirm={async () => {
          await save(null);
        }}
        onDismiss={() => setConfirmingDelete(false)}
      />
    </View>
  );
};

export default NovelNotes;

const styles = StyleSheet.create({
  addRow: { alignItems: 'center', flexDirection: 'row', paddingVertical: 8 },
  addText: { marginLeft: 8 },
  container: { paddingHorizontal: 16, paddingVertical: 4 },
  input: { maxHeight: 240 },
  header: { alignItems: 'center', flexDirection: 'row' },
  text: { lineHeight: 20, paddingBottom: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '500' },
});
